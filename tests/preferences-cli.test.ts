// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const roots: string[] = [];
const entry = resolve("dist/preferences/command.js");
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const home = await mkdtemp(join(await realpath(tmpdir()), "orch-preference-cli-"));
  roots.push(home);
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  return { home, workspace };
}

/** Run the built command in its own process and report its exit code instead of throwing. */
async function cli(home: string, args: string[]): Promise<{ code: number | string | null; stdout: string; stderr: string }> {
  try {
    const done = await exec(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 55_000 });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number | string | null; stdout?: string; stderr?: string };
    return { code: failed.code ?? null, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A failure writes exactly one JSON line with a status and a message. */
function diagnostic(stderr: string): { status: string; message: string } {
  const lines = stderr.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  const parsed = JSON.parse(lines[0]);
  expect(Object.keys(parsed).sort()).toEqual(["message", "status"]);
  return parsed;
}

async function stateDirectory(home: string): Promise<string> {
  const root = join(home, ".orch-private", "preferences-v1");
  return join(root, (await readdir(root))[0]);
}

const set = (workspace: string, key: string, value: string, revision: number) => ["set", key, value, "--workspace", workspace, "--expected-revision", String(revision)];
const unset = (workspace: string, key: string, revision: number) => ["unset", key, "--workspace", workspace, "--expected-revision", String(revision)];
const show = (workspace: string) => ["show", "--workspace", workspace];

const LOCK_HELD = "a set or unset is still running or was interrupted; when none is running, remove the .lock folder in this workspace's folder under .orch-private/preferences-v1 and retry";
const LOCK_LEFT = "the change was written, but the .lock folder could not be removed; when no set or unset is running, remove the .lock folder in this workspace's folder under .orch-private/preferences-v1 before the next set or unset";
const DIRECTORY_NOT_FLUSHED = "the change was written, but the preferences folder could not be flushed; verify the saved preference before retrying";

/** The built command run in a real process with a seam in which removing the writer lock fails. */
async function lockStays(home: string, when: "after-rename" | "always", args: string[]): Promise<{ code: number | string | null; stdout: string; stderr: string }> {
  const fixture = resolve("tests/fixtures/preferences/seam-command.mjs");
  try {
    const done = await exec(process.execPath, [fixture, entry, when, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30_000 });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number | string | null; stdout?: string; stderr?: string };
    return { code: failed.code ?? null, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

// Contract: each command has a five-second bound. The allowance covers starting a process on a busy
// machine. A child that is still alive at the hard limit is killed by the test, so a command that
// never exits fails the exit-status assertion instead of hanging the run.
const COMMAND_BOUND_MS = 5_000;
const START_ALLOWANCE_MS = 1_000;
const HARD_KILL_MS = 8_000;

/** Run the built command with a standard-input pipe that this test never closes. */
function hold(home: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; insideBound: boolean }> {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.stdin.on("error", () => {});
    const hard = setTimeout(() => child.kill("SIGKILL"), HARD_KILL_MS);
    child.on("close", (code, signal) => {
      clearTimeout(hard);
      const elapsed = performance.now() - started;
      // Only now, after the command has ended on its own or been killed, does the test let go of the pipe.
      child.stdin.destroy();
      done({ code, signal, stdout, stderr, insideBound: elapsed < COMMAND_BOUND_MS + START_ALLOWANCE_MS });
    });
  });
}

describe("preference command", () => {
  it("packed preference set survives a new process and can be unset", async () => {
    const { home, workspace } = await setup();
    const saved = await cli(home, set(workspace, "response-language", "zh", 0));
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.stdout).revision).toBe(1);
    expect(JSON.parse((await cli(home, show(workspace))).stdout).preferences).toEqual({ "response-language": "zh" });
    const removed = await cli(home, unset(workspace, "response-language", 1));
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ revision: 2, preferences: {} });
    expect(JSON.parse((await cli(home, show(workspace))).stdout)).toMatchObject({ revision: 2, preferences: {} });
  });

  it("same revision cannot overwrite a concurrent correction", async () => {
    const { home, workspace } = await setup();
    const values = ["short", "normal"];
    const results = await Promise.all(values.map((value) => cli(home, set(workspace, "answer-length", value, 0))));
    expect(results.map((result) => result.code).sort()).toEqual([0, 3]);
    const winner = results.findIndex((result) => result.code === 0);
    expect(results[1 - winner].stdout).toBe("");
    expect(diagnostic(results[1 - winner].stderr).status).toBe("conflict");
    // The stored state is the acknowledged writer's, whole.
    expect(JSON.parse(results[winner].stdout)).toMatchObject({ revision: 1, preferences: { "answer-length": values[winner] } });
    expect(JSON.parse((await cli(home, show(workspace))).stdout)).toMatchObject({ revision: 1, preferences: { "answer-length": values[winner] } });

    // An unset racing a set at one revision: again exactly one of them is acknowledged.
    const other = values[1 - winner];
    const race = await Promise.all([cli(home, unset(workspace, "answer-length", 1)), cli(home, set(workspace, "answer-length", other, 1))]);
    expect(race.map((result) => result.code).sort()).toEqual([0, 3]);
    expect(diagnostic(race[race[0].code === 0 ? 1 : 0].stderr).status).toBe("conflict");
    const after = JSON.parse((await cli(home, show(workspace))).stdout);
    expect(after.revision).toBe(2);
    expect(after.preferences).toEqual(race[0].code === 0 ? {} : { "answer-length": other });
    expect(await readdir(await stateDirectory(home))).toEqual(["state.json"]);
  });

  it("a set that waited for a held lock decides on the revision the holder left", async () => {
    const { home, workspace } = await setup();
    expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
    const directory = await stateDirectory(home);
    const state = join(directory, "state.json");
    const lock = join(directory, ".lock");
    // A cooperating writer holds the lock while a second set arrives with the revision it read earlier.
    await mkdir(lock);
    const late = cli(home, set(workspace, "response-language", "zh", 1));
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The holder finishes its own write, then releases the lock.
    const held = { version: 1, revision: 2, preferences: { "answer-length": { value: "normal", expires_at: "2099-01-01T00:00:00.000Z" } } };
    await writeFile(state, `${JSON.stringify(held)}\n`);
    const bytes = await readFile(state);
    await rmdir(lock);
    const result = await late;
    expect(result.code).toBe(3);
    expect(diagnostic(result.stderr).status).toBe("conflict");
    expect(await readFile(state)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("a held lock makes set and unset unavailable inside the command bound and is never removed", async () => {
    const { home, workspace } = await setup();
    expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
    const directory = await stateDirectory(home);
    const state = join(directory, "state.json");
    const lock = join(directory, ".lock");
    const before = await readFile(state);
    await mkdir(lock);
    for (const args of [set(workspace, "answer-length", "normal", 1), unset(workspace, "answer-length", 1)]) {
      const started = performance.now();
      const result = await cli(home, args);
      const elapsed = performance.now() - started;
      expect({ code: result.code, insideBound: elapsed < 5000 }).toEqual({ code: 4, insideBound: true });
      expect(result.stdout).toBe("");
      // The diagnostic names what to remove by hand.
      const failure = diagnostic(result.stderr);
      expect(failure.status).toBe("unavailable");
      expect(failure.message).toContain(".lock");
      expect(failure.message).toContain(".orch-private/preferences-v1");
      await access(lock);
      expect(await readFile(state)).toEqual(before);
    }
    expect(JSON.parse((await cli(home, show(workspace))).stdout)).toMatchObject({ revision: 1, preferences: { "answer-length": "short" } });
  });

  it("no command reads standard input, so an input that is never closed does not hold one open", async () => {
    const { home, workspace } = await setup();
    const results = [];
    for (const args of [set(workspace, "answer-length", "short", 0), show(workspace), unset(workspace, "answer-length", 1)]) results.push(await hold(home, args));
    expect(results.map(({ code, signal, stderr, insideBound }) => ({ code, signal, stderr, insideBound }))).toEqual(results.map(() => ({ code: 0, signal: null, stderr: "", insideBound: true })));
    expect(results.map((result) => JSON.parse(result.stdout).revision)).toEqual([1, 1, 2]);
  });

  describe("a writer lock that cannot be removed", () => {
    it("a set that was written is reported as written, the left-over lock is named, and the next change is refused", async () => {
      const { home, workspace } = await setup();
      const result = await lockStays(home, "after-rename", set(workspace, "answer-length", "short", 0));
      // The change happened, so the command says so: status 0 and the new settings on standard output.
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ source: "explicit-command", revision: 1, preferences: { "answer-length": "short" }, expiry: { "answer-length": expect.any(String) } });
      // The left-over lock is reported once, on standard error, with the fixed text that names the way out.
      expect(result.stderr).toBe(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
      const directory = await stateDirectory(home);
      const state = join(directory, "state.json");
      const lock = join(directory, ".lock");
      expect((await readdir(directory)).sort()).toEqual([".lock", "state.json"]);
      expect(JSON.parse((await cli(home, show(workspace))).stdout)).toMatchObject({ revision: 1, preferences: { "answer-length": "short" } });

      // The next change is the documented stale-lock case: refused, the lock and the state left alone.
      const bytes = await readFile(state);
      const next = await cli(home, set(workspace, "answer-length", "normal", 1));
      expect(next).toEqual({ code: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: LOCK_HELD })}\n` });
      await access(lock);
      expect(await readFile(state)).toEqual(bytes);

      // After the documented manual step the store continues from the revision that was acknowledged.
      await rmdir(lock);
      expect((await cli(home, set(workspace, "answer-length", "normal", 0))).code).toBe(3);
      expect((await cli(home, set(workspace, "answer-length", "normal", 1))).code).toBe(0);
    });

    it("an unset that was written is reported as written with the same warning", async () => {
      const { home, workspace } = await setup();
      expect((await cli(home, set(workspace, "response-language", "zh", 0))).code).toBe(0);
      const result = await lockStays(home, "after-rename", unset(workspace, "response-language", 1));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ source: "explicit-command", revision: 2, preferences: {}, expiry: {} });
      expect(result.stderr).toBe(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
      const directory = await stateDirectory(home);
      expect((await readdir(directory)).sort()).toEqual([".lock", "state.json"]);
      expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain("zh");
      expect(JSON.parse((await cli(home, show(workspace))).stdout)).toMatchObject({ revision: 2, preferences: {} });
    });

    it("a change that was refused keeps its own refusal when the lock also cannot be removed", async () => {
      const { home, workspace } = await setup();
      expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
      const directory = await stateDirectory(home);
      const bytes = await readFile(join(directory, "state.json"));
      const result = await lockStays(home, "always", set(workspace, "answer-length", "normal", 0));
      expect(result).toEqual({ code: 3, stdout: "", stderr: `${JSON.stringify({ status: "conflict", message: "preference revision conflict" })}\n` });
      expect(await readFile(join(directory, "state.json"))).toEqual(bytes);
      expect((await readdir(directory)).sort()).toEqual([".lock", "state.json"]);
    });
  });

  it("a directory flush failure reports the installed change and permits only its new revision", async () => {
    const { home, workspace } = await setup();
    const result = await lockStays(home, "directory-flush", set(workspace, "answer-length", "short", 0));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ revision: 1, preferences: { "answer-length": "short" } });
    expect(result.stderr).toBe(`${JSON.stringify({ status: "warning", message: DIRECTORY_NOT_FLUSHED })}\n`);
    expect((await cli(home, set(workspace, "answer-length", "normal", 0))).code).toBe(3);
    expect((await cli(home, set(workspace, "answer-length", "normal", 1))).code).toBe(0);
  });

  it.each([
    ["state", { version: 1, revision: 1, preferences: {}, extra: true }],
    ["preferences", { version: 1, revision: 1, preferences: { unknown: { value: "short", expires_at: "2099-01-01T00:00:00.000Z" } } }],
    ["stored preference", {
      version: 1,
      revision: 1,
      preferences: { "answer-length": { value: "short", expires_at: "2099-01-01T00:00:00.000Z", extra: true } },
    }],
  ])("unknown fields at the %s level are refused by show, set and unset", async (_level, stored) => {
    const { home, workspace } = await setup();
    expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
    const state = join(await stateDirectory(home), "state.json");
    const bytes = `${JSON.stringify(stored)}\n`;
    await writeFile(state, bytes);
    for (const args of [show(workspace), set(workspace, "answer-length", "normal", 1), unset(workspace, "answer-length", 1)]) {
      const result = await cli(home, args);
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(await readFile(state, "utf8")).toBe(bytes);
    }
  });

  it("failures use one status scheme and never echo what the caller typed", async () => {
    const { home, workspace } = await setup();
    const canary = "ARGUMENT-CANARY-23";
    // Invalid requests: status 2, nothing written.
    for (const args of [
      set(workspace, "allow-send", canary, 0),
      set(workspace, "answer-length", canary, 0),
      unset(workspace, canary, 0),
      ["set", "answer-length", "short", "--workspace", workspace],
      [...set(workspace, "answer-length", "short", 0), `--approved=${canary}`],
      [...set(workspace, "answer-length", "short", 0), canary],
      [canary],
    ]) {
      const result = await cli(home, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(diagnostic(result.stderr).status).toBe("invalid");
      expect(result.stderr).not.toContain(canary);
    }
    await expect(access(join(home, ".orch-private"))).rejects.toMatchObject({ code: "ENOENT" });

    // A stale revision: status 3, state unchanged.
    expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
    const state = join(await stateDirectory(home), "state.json");
    const acknowledged = await readFile(state);
    for (const args of [set(workspace, "answer-length", "normal", 0), unset(workspace, "answer-length", 0), set(workspace, "answer-length", "normal", 2)]) {
      const result = await cli(home, args);
      expect(result.code).toBe(3);
      expect(diagnostic(result.stderr).status).toBe("conflict");
      expect(await readFile(state)).toEqual(acknowledged);
    }

    // Corrupt state: status 4 for every action, bytes unchanged, nothing reset.
    await writeFile(state, "{broken");
    const corrupt = await readFile(state);
    for (const args of [show(workspace), set(workspace, "answer-length", "normal", 1), set(workspace, "answer-length", "normal", 0), unset(workspace, "answer-length", 1)]) {
      const result = await cli(home, args);
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(diagnostic(result.stderr).status).toBe("unavailable");
      expect(await readFile(state)).toEqual(corrupt);
    }
    expect(await readdir(await stateDirectory(home))).toEqual(["state.json"]);
  });
});

describe.skipIf(process.platform === "win32")("a named pipe where the state file should be", () => {
  it("is refused with status 4 without waiting for a writer", async () => {
    const { home, workspace } = await setup();
    expect((await cli(home, set(workspace, "answer-length", "short", 0))).code).toBe(0);
    const state = join(await stateDirectory(home), "state.json");
    await rm(state);
    await exec("mkfifo", [state]);
    for (const args of [["show", "--workspace", workspace], set(workspace, "answer-length", "normal", 1)]) {
      // A command that waits on the pipe is killed at the limit and then has no exit code.
      let outcome: { code: number | string | null; stdout: string; stderr: string };
      try {
        const done = await exec(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 8_000 });
        outcome = { code: 0, stdout: done.stdout, stderr: done.stderr };
      } catch (error) {
        const failed = error as { code?: number | string | null; stdout?: string; stderr?: string };
        outcome = { code: failed.code ?? null, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
      expect(outcome.code, args[0]).toBe(4);
      expect(outcome.stdout).toBe("");
      expect(diagnostic(outcome.stderr)).toEqual({ status: "unavailable", message: "unsafe preference state" });
    }
    expect((await readdir(await stateDirectory(home))).sort()).toEqual(["state.json"]);
  });
});
