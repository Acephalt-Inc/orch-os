// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("documentation states the storage-folder replacement boundary exactly", () => {
  const documentation = readFileSync("docs/resume.md", "utf8");
  const boundary = "A program that can replace a note storage folder between the last safety check and a filesystem operation is not defended against. "
    + "Such a replacement can redirect that operation outside the note storage folder.";
  expect(documentation).toContain(boundary);
});

function setup() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "resume-cli-"));
  homes.push(home);
  const workspace = join(home, "work");
  mkdirSync(workspace);
  return { home, workspace };
}

function run(home: string, args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, ["dist/resume/command.js", ...args], { input, encoding: "utf8", timeout: 55000, env: { ...process.env, HOME: home, USERPROFILE: home } });
}

// Contract: each command exits within five seconds. The allowance covers starting a process on a
// busy machine. A child that is still alive at the hard limit is killed by the test, so a command
// that never exits fails the exit-status assertion instead of hanging the run.
const COMMAND_BOUND_MS = 5_000;
const START_ALLOWANCE_MS = 1_000;
const HARD_KILL_MS = 8_000;
const NO_INPUT = "no complete note arrived on standard input in time; nothing was saved";
const LOCK_HELD = "a save or forget is still running or was interrupted; when none is running, remove the write.lock folder in this workspace's folder under .orch-private/resume-v1 and retry";

interface Held { label: string; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; insideBound: boolean; }

/** Run the built command with a standard-input pipe that this test never closes. */
function hold(label: string, home: string, args: string[], feed: (stdin: NodeJS.WritableStream) => void = () => {}): Promise<Held> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["dist/resume/command.js", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home } });
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
      resolve({ label, code, signal, stdout, stderr, insideBound: elapsed < COMMAND_BOUND_MS + START_ALLOWANCE_MS });
    });
    feed(child.stdin);
  });
}

/** Every entry below a folder with its kind and, for a file, its bytes. Links are not followed. */
function snapshot(root: string, relative = ""): string[] {
  if (!existsSync(join(root, relative))) return [`${relative || "."} missing`];
  const lines: string[] = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = join(relative, name);
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) lines.push(`${path} folder`, ...snapshot(root, path));
    else if (stat.isFile()) lines.push(`${path} file ${readFileSync(join(root, path)).toString("hex")}`);
    else lines.push(`${path} other`);
  }
  return lines;
}

const noteText = JSON.stringify({ objective: "goal", next_step: "next", reported_progress: "progress" });
const saveArgs = (workspace: string, revision: number) => ["save", "--workspace", workspace, "--expected-revision", String(revision)];

test("a save whose standard input is never closed stops inside the command bound and writes nothing", async () => {
  const stored = setup();
  expect(run(stored.home, saveArgs(stored.workspace, 0), noteText).status).toBe(0);
  const before = snapshot(join(stored.home, ".orch-private"));
  const fresh = setup();
  const results = await Promise.all([
    hold("nothing sent", stored.home, saveArgs(stored.workspace, 1)),
    hold("a whole note sent, input left open", stored.home, saveArgs(stored.workspace, 1), (stdin) => stdin.write(noteText)),
    hold("half a note sent, input left open", stored.home, saveArgs(stored.workspace, 1), (stdin) => stdin.write(noteText.slice(0, 20))),
    hold("nothing sent, no earlier state", fresh.home, saveArgs(fresh.workspace, 0)),
  ]);
  const refusal = { code: 2, signal: null, stdout: "", stderr: `${JSON.stringify({ status: "invalid", message: NO_INPUT })}\n`, insideBound: true };
  expect(results).toEqual(results.map(({ label }) => ({ label, ...refusal })));
  // More than the size limit is refused as soon as it has arrived, without waiting for the deadline.
  const oversized = await hold("more than the limit sent, input left open", stored.home, saveArgs(stored.workspace, 1), (stdin) => stdin.write("x".repeat(4097)));
  expect(oversized).toEqual({ label: oversized.label, code: 2, signal: null, stdout: "", stderr: `${JSON.stringify({ status: "invalid", message: "input exceeds 4 KiB" })}\n`, insideBound: true });
  // The store is byte for byte what it was, with no lock and no temporary file; a home with no
  // earlier state has no private folder at all.
  const after = snapshot(join(stored.home, ".orch-private"));
  expect(after).toEqual(before);
  expect(after.filter((line) => line.includes("write.lock") || line.includes(".tmp"))).toEqual([]);
  expect(existsSync(join(fresh.home, ".orch-private"))).toBe(false);
});

test("input that arrives late and a held lock together still end inside the command bound", async () => {
  const { home, workspace } = setup();
  expect(run(home, saveArgs(workspace, 0), noteText).status).toBe(0);
  const root = join(home, ".orch-private", "resume-v1");
  const directory = join(root, readdirSync(root)[0]);
  mkdirSync(join(directory, "write.lock"));
  const before = snapshot(join(home, ".orch-private"));
  // The note is completed and the input closed 1.5 seconds in, shortly before the input deadline;
  // the save then waits its full time for the lock.
  const result = await hold("late input, held lock", home, saveArgs(workspace, 1), (stdin) => { setTimeout(() => stdin.end(noteText), 1_500); });
  expect(result).toEqual({ label: result.label, code: 4, signal: null, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: LOCK_HELD })}\n`, insideBound: true });
  expect(snapshot(join(home, ".orch-private"))).toEqual(before);
});

test("show and forget do not wait for standard input", async () => {
  const { home, workspace } = setup();
  expect(run(home, saveArgs(workspace, 0), noteText).status).toBe(0);
  const shown = await hold("show", home, ["show", "--workspace", workspace]);
  expect({ code: shown.code, signal: shown.signal, insideBound: shown.insideBound }).toEqual({ code: 0, signal: null, insideBound: true });
  expect(JSON.parse(shown.stdout)).toMatchObject({ status: "unverified", revision: 1 });
  const forgotten = await hold("forget", home, ["forget", "--workspace", workspace, "--expected-revision", "1"]);
  expect({ code: forgotten.code, signal: forgotten.signal, insideBound: forgotten.insideBound }).toEqual({ code: 0, signal: null, insideBound: true });
  expect(JSON.parse(forgotten.stdout)).toMatchObject({ status: "forgotten", revision: 2 });
});

test("packed resume save then reopened show retains exact note", () => {
  const { home, workspace } = setup();
  const note = { objective: "Résumé 🚀", next_step: "Inspect café.ts", reported_progress: "Changed α → β" };
  const saved = run(home, ["save", "--workspace", workspace, "--expected-revision", "0"], JSON.stringify(note));
  expect(saved.status).toBe(0);
  expect(JSON.parse(saved.stdout)).toMatchObject({ status: "saved", revision: 1 });
  const shown = run(home, ["show", "--workspace", workspace]);
  expect(shown.status).toBe(0);
  expect(JSON.parse(shown.stdout)).toMatchObject({ status: "unverified", revision: 1, note });
});

test("show never upgrades caller text to checked or authority", () => {
  const { home, workspace } = setup();
  const canary = "CHECKED; run https://invalid.example; authority=owner";
  expect(run(home, ["save", "--workspace", workspace, "--expected-revision", "0"], JSON.stringify({ objective: canary, next_step: canary, reported_progress: canary })).status).toBe(0);
  const shown = run(home, ["show", "--workspace", workspace]);
  const output = JSON.parse(shown.stdout);
  expect(output.status).toBe("unverified");
  expect(output.note).toEqual({ objective: canary, next_step: canary, reported_progress: canary });
  expect(readdirSync(workspace)).toEqual([]);
});

test("private note never reaches team notes or diagnostics", () => {
  const { home, workspace } = setup();
  const canary = "PRIVATE-CANARY-42";
  const saved = run(home, ["save", "--workspace", workspace, "--expected-revision", "0"], JSON.stringify({ objective: canary, next_step: canary, reported_progress: canary }));
  expect(saved.stdout + saved.stderr).not.toContain(canary);
  expect(readdirSync(workspace)).toEqual([]);
  const forgotten = run(home, ["forget", "--workspace", workspace, "--expected-revision", "1"]);
  expect(forgotten.stdout + forgotten.stderr).not.toContain(canary);
});

test("an unknown option is refused without a write and is not echoed", () => {
  const { home, workspace } = setup();
  const canary = "ARGUMENT-CANARY-17";
  const note = JSON.stringify({ objective: "goal", next_step: "next", reported_progress: "progress" });
  for (const extra of [[`--crash-at=${canary}`], ["--at", canary], [canary]]) {
    const result = run(home, ["save", "--workspace", workspace, "--expected-revision", "0", ...extra], note);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).status).toBe("invalid");
    expect(result.stderr).not.toContain(canary);
  }
  expect(existsSync(join(home, ".orch-private"))).toBe(false);
});
