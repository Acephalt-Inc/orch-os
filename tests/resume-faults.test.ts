// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, test } from "vitest";
import { write, type WritePoint } from "../src/resume/store.js";

const homes: string[] = [];
const outerHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const [key, value] of Object.entries(outerHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "resume-faults-"));
  homes.push(home);
  const workspace = join(home, "work");
  mkdirSync(workspace);
  return { home, workspace, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

/** For the tests that call the store in this process: the store derives its root from the user's home. */
function setupInProcess() {
  const made = setup();
  process.env.HOME = made.home;
  process.env.USERPROFILE = made.home;
  return made;
}

function run(env: NodeJS.ProcessEnv, args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, ["dist/resume/command.js", ...args], { input, encoding: "utf8", timeout: 55000, env });
}

/** One write through the built store, killed by its own SIGKILL at the named point. */
function crash(env: NodeJS.ProcessEnv, workspace: string, revision: number, point: WritePoint, input: string) {
  const fixture = resolve("tests/fixtures/resume/crash-writer.mjs");
  return spawnSync(process.execPath, [fixture, resolve("dist/resume/store.js"), workspace, String(revision), point, input], { encoding: "utf8", timeout: 30000, env });
}

/** The built command run in a real process with a seam in which removing the writer lock fails. */
function faultCommand(env: NodeJS.ProcessEnv, when: "after-rename" | "always" | "folder-flush", args: string[], input?: string) {
  const fixture = resolve("tests/fixtures/resume/seam-command.mjs");
  return spawnSync(process.execPath, [fixture, resolve("dist/resume/command.js"), when, ...args], { input, encoding: "utf8", timeout: 30000, env });
}

function stateDirectory(home: string): string {
  const root = join(home, ".orch-private", "resume-v1");
  return join(root, readdirSync(root)[0]);
}

const noteOf = (objective: string) => ({ objective, next_step: "next", reported_progress: "progress" });
const note = JSON.stringify(noteOf("goal"));
const save = (workspace: string, revision: number) => ["save", "--workspace", workspace, "--expected-revision", String(revision)];
const forget = (workspace: string, revision: number) => ["forget", "--workspace", workspace, "--expected-revision", String(revision)];
const OLD = "old-objective-7f3a", NEW = "new-objective-c41e", LATER = "later-objective-99b2";
const LOCK_HELD = "a save or forget is still running or was interrupted; when none is running, remove the write.lock folder in this workspace's folder under .orch-private/resume-v1 and retry";
const LOCK_LEFT = "the change was written, but the write.lock folder could not be removed; when no save or forget is running, remove the write.lock folder in this workspace's folder under .orch-private/resume-v1 before the next save or forget";
const DIRECTORY_NOT_FLUSHED = "the change was written, but the note storage folder could not be flushed; verify the saved note before retrying";

/** Save OLD at revision 1, then start a save of NEW that is killed at `point`. */
function interrupted(point: WritePoint) {
  const made = setup();
  expect(run(made.env, save(made.workspace, 0), JSON.stringify(noteOf(OLD))).status).toBe(0);
  const directory = stateDirectory(made.home);
  const state = join(directory, "state.json");
  const oldBytes = readFileSync(state);
  const child = crash(made.env, made.workspace, 1, point, JSON.stringify(noteOf(NEW)));
  // The write really reached the point and really died there: neither numbered exit of the fixture was taken.
  expect(child.stdout).toBe(`reached ${point}\n`);
  expect([0, 97, 98]).not.toContain(child.status);
  if (process.platform !== "win32") expect(child.signal).toBe("SIGKILL");
  return { ...made, directory, state, lock: join(directory, "write.lock"), oldBytes };
}

describe("crash boundaries preserve acknowledged state or report unavailable", () => {
  it.each<WritePoint>(["locked", "temp-flushed", "renamed"])("a save killed at %s leaves the old or the new valid record", (point) => {
    const { env, workspace, directory, state, lock, oldBytes } = interrupted(point);
    const replaced = point === "renamed";
    const current = replaced ? 2 : 1;

    // The state file holds the old record byte for byte, or the complete new record.
    const afterBytes = readFileSync(state);
    if (replaced) {
      const record = JSON.parse(afterBytes.toString("utf8"));
      expect(Object.keys(record).sort()).toEqual(["id", "note", "revision", "saved_at", "schema"]);
      expect(record).toMatchObject({ schema: 1, revision: 2, note: noteOf(NEW) });
      expect(afterBytes.toString("utf8")).toBe(`${JSON.stringify(record)}\n`);
    } else {
      expect(afterBytes).toEqual(oldBytes);
    }
    // A flushed temporary file holding the new note exists only at the middle boundary.
    const temporaries = readdirSync(directory).filter((name) => name.endsWith(".tmp"));
    expect(temporaries).toHaveLength(point === "temp-flushed" ? 1 : 0);
    for (const name of temporaries) expect(readFileSync(join(directory, name), "utf8")).toContain(NEW);

    // Reading still works and returns a valid record.
    const shown = run(env, ["show", "--workspace", workspace]);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ status: "unverified", revision: current, note: noteOf(replaced ? NEW : OLD) });

    // The dead writer's lock is still there: the next save is refused, and nothing is taken over.
    const refused = run(env, save(workspace, current), JSON.stringify(noteOf(LATER)));
    expect(refused.status).toBe(4);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(state)).toEqual(afterBytes);

    // After the documented manual step the store accepts only the current revision.
    rmdirSync(lock);
    if (replaced) expect(run(env, save(workspace, 1), JSON.stringify(noteOf(LATER))).status).toBe(3);
    expect(run(env, save(workspace, current), JSON.stringify(noteOf(LATER))).status).toBe(0);
    // No owned file other than the state survives, so no temporary file still holds note text.
    expect(readdirSync(directory)).toEqual(["state.json"]);
    expect(readFileSync(state, "utf8")).not.toContain(NEW);
  });

  it("a forget after an interrupted save leaves no note text in any owned file", () => {
    const { env, workspace, directory, state, lock } = interrupted("temp-flushed");
    rmdirSync(lock);
    expect(run(env, forget(workspace, 1)).status).toBe(0);
    expect(readdirSync(directory)).toEqual(["state.json"]);
    const text = readFileSync(state, "utf8");
    expect(text).not.toContain(OLD);
    expect(text).not.toContain(NEW);
    expect(JSON.parse(run(env, ["show", "--workspace", workspace]).stdout)).toEqual({ status: "absent", revision: 2 });
  });

  it("the temporary file is flushed before it replaces the state", () => {
    const { workspace } = setupInProcess();
    const steps: string[] = [];
    write(workspace, 0, noteOf("goal"), { at: (point) => steps.push(point), fsync: (fd) => { steps.push("flush"); fsyncSync(fd); } });
    expect(steps.slice(0, 4)).toEqual(["locked", "flush", "temp-flushed", "renamed"]);
  });

  it("a failed flush leaves no temporary file, no state and no lock", () => {
    const { home, workspace } = setupInProcess();
    expect(() => write(workspace, 0, noteOf("goal"), { fsync: () => { throw new Error("flush failed"); } })).toThrow("flush failed");
    expect(readdirSync(stateDirectory(home))).toEqual([]);
  });

  it("an existing storage folder owned by another uid is refused without changing it", () => {
    const { home, workspace } = setupInProcess();
    const root = join(home, ".orch-private");
    mkdirSync(root, { mode: 0o700 });
    const before = { mode: statSync(root).mode, entries: readdirSync(root) };
    expect(() => write(workspace, 0, noteOf("goal"), { uid: process.getuid!() + 1 })).toThrow("unsafe storage directory");
    expect({ mode: statSync(root).mode, entries: readdirSync(root) }).toEqual(before);
  });

  it("an existing storage folder accessible to a group is refused without changing it", () => {
    const { home, workspace } = setupInProcess();
    const root = join(home, ".orch-private");
    mkdirSync(root, { mode: 0o750 });
    const before = { mode: statSync(root).mode, entries: readdirSync(root) };
    expect(() => write(workspace, 0, noteOf("goal"))).toThrow("storage directory is not private");
    expect({ mode: statSync(root).mode, entries: readdirSync(root) }).toEqual(before);
  });

  it("a platform that cannot sync a directory still acknowledges the write it made", () => {
    const { home, workspace } = setupInProcess();
    const refuse = () => { throw Object.assign(new Error("a directory cannot be opened here"), { code: "EPERM" }); };
    let outcome: unknown;
    try { outcome = write(workspace, 0, noteOf("goal"), { platform: "win32", openDirectory: refuse }).record.revision; }
    catch (error) { outcome = error instanceof Error ? `threw: ${error.message}` : "threw"; }
    expect(outcome).toBe(1);
    const directory = stateDirectory(home);
    expect(readdirSync(directory)).toEqual(["state.json"]);
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))).toMatchObject({ revision: 1, note: noteOf("goal") });
  });
});

describe("stale lock and corrupt state are not silently recovered", () => {
  it("corrupt state stays unavailable and its bytes are not changed", () => {
    const { home, env, workspace } = setup();
    expect(run(env, save(workspace, 0), note).status).toBe(0);
    const directory = stateDirectory(home);
    const state = join(directory, "state.json");
    writeFileSync(state, "{broken");
    const before = readFileSync(state);
    for (const [args, input] of [[["show", "--workspace", workspace]], [save(workspace, 1), note], [save(workspace, 0), note], [forget(workspace, 1)]] as [string[], string?][]) {
      const result = run(env, args, input);
      expect(result.status).toBe(4);
      expect(JSON.parse(result.stderr).status).toBe("unavailable");
      expect(readFileSync(state)).toEqual(before);
    }
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("a held lock refuses writes inside the command bound and is never removed", () => {
    const canary = "PRIVATE-CANARY-58";
    const { home, env, workspace } = setup();
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(canary))).status).toBe(0);
    const directory = stateDirectory(home);
    const state = join(directory, "state.json");
    const lock = join(directory, "write.lock");
    const before = readFileSync(state);
    mkdirSync(lock);
    for (const [args, input] of [[save(workspace, 1), JSON.stringify(noteOf(canary))], [forget(workspace, 1)]] as [string[], string?][]) {
      const started = performance.now();
      const result = run(env, args, input);
      const elapsed = performance.now() - started;
      expect({ status: result.status, insideBound: elapsed < 5000 }).toEqual({ status: 4, insideBound: true });
      // The diagnostic names what to remove by hand and carries no note text.
      const diagnostic = JSON.parse(result.stderr);
      expect(diagnostic.status).toBe("unavailable");
      expect(diagnostic.message).toContain("write.lock");
      expect(diagnostic.message).toContain(".orch-private/resume-v1");
      expect(result.stdout + result.stderr).not.toContain(canary);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(state)).toEqual(before);
    }
    expect(run(env, ["show", "--workspace", workspace]).status).toBe(0);
  });
});

describe("a writer lock that cannot be removed", () => {
  it("a save that was written is reported as written, the left-over lock is named, and the next write is refused", () => {
    const { home, env, workspace } = setup();
    const result = faultCommand(env, "after-rename", save(workspace, 0), JSON.stringify(noteOf(OLD)));
    // The write happened, so the command says so: status 0 and the record's identity on standard output.
    expect(result.status).toBe(0);
    const saved = JSON.parse(result.stdout);
    expect(saved).toEqual({ status: "saved", id: expect.stringMatching(/^[0-9a-f-]{36}$/), revision: 1 });
    // The left-over lock is reported once, on standard error, with the fixed text that names the way out.
    expect(result.stderr).toBe(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
    const directory = stateDirectory(home);
    const state = join(directory, "state.json");
    const lock = join(directory, "write.lock");
    expect(readdirSync(directory).sort()).toEqual(["state.json", "write.lock"]);
    const shown = run(env, ["show", "--workspace", workspace]);
    expect(JSON.parse(shown.stdout)).toEqual({ status: "unverified", id: saved.id, revision: 1, saved_at: expect.any(String), note: noteOf(OLD) });

    // The next write is the documented stale-lock case: refused, the lock and the record left alone.
    const bytes = readFileSync(state);
    const next = run(env, save(workspace, 1), JSON.stringify(noteOf(LATER)));
    expect({ status: next.status, stdout: next.stdout, stderr: next.stderr }).toEqual({ status: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: LOCK_HELD })}\n` });
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(state)).toEqual(bytes);

    // After the documented manual step the store continues from the revision that was acknowledged.
    rmdirSync(lock);
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(LATER))).status).toBe(3);
    expect(run(env, save(workspace, 1), JSON.stringify(noteOf(LATER))).status).toBe(0);
  });

  it("a forget that was written is reported as written with the same warning", () => {
    const { home, env, workspace } = setup();
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(OLD))).status).toBe(0);
    const result = faultCommand(env, "after-rename", forget(workspace, 1));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "forgotten", id: expect.stringMatching(/^[0-9a-f-]{36}$/), revision: 2 });
    expect(result.stderr).toBe(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
    const directory = stateDirectory(home);
    expect(readdirSync(directory).sort()).toEqual(["state.json", "write.lock"]);
    expect(readFileSync(join(directory, "state.json"), "utf8")).not.toContain(OLD);
    expect(JSON.parse(run(env, ["show", "--workspace", workspace]).stdout)).toEqual({ status: "absent", revision: 2 });
  });

  it("a write that was refused keeps its own refusal when the lock also cannot be removed", () => {
    const { home, env, workspace } = setup();
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(OLD))).status).toBe(0);
    const directory = stateDirectory(home);
    const bytes = readFileSync(join(directory, "state.json"));
    const result = faultCommand(env, "always", save(workspace, 0), JSON.stringify(noteOf(NEW)));
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 3, stdout: "", stderr: `${JSON.stringify({ status: "conflict", message: "revision conflict" })}\n` });
    expect(readFileSync(join(directory, "state.json"))).toEqual(bytes);
    expect(readdirSync(directory).sort()).toEqual(["state.json", "write.lock"]);
  });
});

test("a folder flush failure after rename is a warning and revisions continue from the written record", () => {
  const { home, env, workspace } = setup();
  const first = faultCommand(env, "folder-flush", save(workspace, 0), JSON.stringify(noteOf(OLD)));
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ status: "saved", revision: 1 });
  expect(first.stderr).toBe(`${JSON.stringify({ status: "warning", message: DIRECTORY_NOT_FLUSHED })}\n`);
  const written = JSON.parse(readFileSync(join(stateDirectory(home), "state.json"), "utf8"));
  expect(written).toMatchObject({ revision: 1, note: noteOf(OLD) });
  expect(run(env, save(workspace, 0), JSON.stringify(noteOf(LATER))).status).toBe(3);
  expect(run(env, save(workspace, 1), JSON.stringify(noteOf(LATER))).status).toBe(0);
});

test("oversized invalid input is rejected without a write", () => {
  const { home, env, workspace } = setup();
  const boundaryWorkspace = join(home, "boundary");
  mkdirSync(boundaryWorkspace);
  const boundary = JSON.stringify({ objective: "x".repeat(1024), next_step: "", reported_progress: "" });
  expect(run(env, save(boundaryWorkspace, 0), boundary.padEnd(4096, " ")).status).toBe(0);
  const invalid = [Buffer.from([0xff]), JSON.stringify({ objective: "x".repeat(1025), next_step: "", reported_progress: "" }), JSON.stringify({ objective: "", next_step: "", reported_progress: "", extra: true }), "x".repeat(4097)];
  for (const input of invalid) {
    const result = run(env, save(workspace, 0), input);
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("xxxx");
  }
  const version = join(home, ".orch-private", "resume-v1");
  expect(!existsSync(version) || readdirSync(version).length === 1).toBe(true);
});
