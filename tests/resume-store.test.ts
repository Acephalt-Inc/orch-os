// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lchmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, test } from "vitest";
import { show } from "../src/resume/store.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function setup() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "resume-store-"));
  homes.push(home);
  const workspace = join(home, "work");
  mkdirSync(workspace);
  return { home, workspace, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function run(env: NodeJS.ProcessEnv, args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, ["dist/resume/command.js", ...args], { input, encoding: "utf8", timeout: 55000, env });
}

/** Start the command without waiting for it, so that two can run at once. */
function launch(env: NodeJS.ProcessEnv, args: string[], input: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ["dist/resume/command.js", ...args], { env, stdio: ["pipe", "pipe", "pipe"], timeout: 55000 });
    let out = "", err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function stateDirectory(home: string): string {
  const root = join(home, ".orch-private", "resume-v1");
  return join(root, readdirSync(root)[0]);
}

const noteOf = (objective: string) => ({ objective, next_step: "next", reported_progress: "progress" });
const note = JSON.stringify(noteOf("goal"));
const save = (workspace: string, revision: number) => ["save", "--workspace", workspace, "--expected-revision", String(revision)];

test("two saves at one revision produce one conflict", async () => {
  const { home, env, workspace } = setup();
  const objectives = ["first-writer", "second-writer"];
  const results = await Promise.all(objectives.map((objective) => launch(env, save(workspace, 0), JSON.stringify(noteOf(objective)))));
  expect(results.map((result) => result.code).sort()).toEqual([0, 3]);
  const winner = results.findIndex((result) => result.code === 0);
  const loser = results[1 - winner];
  expect(loser.out).toBe("");
  expect(JSON.parse(loser.err).status).toBe("conflict");
  const saved = JSON.parse(results[winner].out);
  expect(saved).toMatchObject({ status: "saved", revision: 1 });
  // The stored record is the acknowledged writer's, whole.
  const shown = JSON.parse(run(env, ["show", "--workspace", workspace]).stdout);
  expect(shown).toMatchObject({ status: "unverified", id: saved.id, revision: 1, note: noteOf(objectives[winner]) });
  expect(readdirSync(stateDirectory(home))).toEqual(["state.json"]);
});

test("a save that waited for a held lock decides on the revision the holder left", async () => {
  const { home, env, workspace } = setup();
  expect(run(env, save(workspace, 0), note).status).toBe(0);
  const directory = stateDirectory(home);
  const state = join(directory, "state.json");
  const lock = join(directory, "write.lock");
  // A cooperating writer holds the lock while a second save arrives with the revision it read earlier.
  mkdirSync(lock);
  const late = launch(env, save(workspace, 1), JSON.stringify(noteOf("late-writer")));
  await new Promise((resolve) => setTimeout(resolve, 600));
  // The holder finishes its own write, then releases the lock.
  const held = { schema: 1, id: "00000000-0000-4000-8000-000000000002", revision: 2, saved_at: "2026-01-01T00:00:00.000Z", note: noteOf("holder") };
  writeFileSync(state, `${JSON.stringify(held)}\n`);
  const bytes = readFileSync(state);
  rmdirSync(lock);
  const result = await late;
  expect(result.code).toBe(3);
  expect(JSON.parse(result.err).status).toBe("conflict");
  expect(readFileSync(state)).toEqual(bytes);
  expect(readdirSync(directory)).toEqual(["state.json"]);
});

interface Call { op: string; paths: string[]; }
let traces = 0;

/**
 * The built command with every file-system call it makes recorded (see the fixture). The record is
 * what lets a test say that a file was not opened, instead of only that its bytes did not change.
 */
function traced(base: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const log = join(base, `trace-${traces++}.log`);
  const preload = pathToFileURL(resolve("tests/fixtures/resume/fs-trace.mjs")).href;
  const result = spawnSync(process.execPath, ["--import", preload, "dist/resume/command.js", ...args], { input, encoding: "utf8", timeout: 55000, env: { ...env, FS_TRACE_FILE: log } });
  const calls: Call[] = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// Looking at a path without following it: the only call a command may make on a link itself.
const NO_FOLLOW = new Set(["lstatSync"]);

/** The recorded calls that went through `path`: any call below it, and any call on it that follows a link. */
function through(calls: Call[], path: string): string[] {
  return calls.filter((call) => call.paths.some((used) => used.startsWith(path + sep) || (used === path && !NO_FOLLOW.has(call.op))))
    .map((call) => `${call.op} ${call.paths.map((used) => used.replace(path, "<link>")).join(" ")}`);
}

/** Every entry below a folder with its kind and, for a file, its bytes and link count. Links are not followed. */
function snapshot(root: string, relative = ""): string[] {
  const lines: string[] = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = join(relative, name);
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) lines.push(`${path} folder`, ...snapshot(root, path));
    else if (stat.isFile()) lines.push(`${path} file links=${stat.nlink} ${readFileSync(join(root, path)).toString("hex")}`);
    else lines.push(`${path} ${stat.isSymbolicLink() ? "link" : "other"}`);
  }
  return lines;
}

/** A link whose own permission bits are private, so that only a check for the link itself can refuse it. */
function privateLink(target: string, path: string): void {
  symlinkSync(target, path);
  if (process.platform === "darwin") lchmodSync(path, 0o700);
}

const CANARY = "canary-behind-the-link-5d2e";
const forget = (workspace: string, revision: number) => ["forget", "--workspace", workspace, "--expected-revision", String(revision)];

/** A home, a workspace and a folder outside both, none of them inside another. */
function layout() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "resume-links-"));
  homes.push(base);
  const home = join(base, "home"), workspace = join(base, "work"), outside = join(base, "outside");
  for (const folder of [home, workspace, outside]) mkdirSync(folder);
  return { base, home, workspace, outside, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

/** The three commands, each as it would be accepted if nothing were linked. */
function commands(workspace: string, revision: number): [string, string[], string?][] {
  return [["show", ["show", "--workspace", workspace]], ["save", save(workspace, revision), note], ["forget", forget(workspace, revision)]];
}

describe("native roots links and workspace identities stay distinct", () => {
  it("two workspaces with one name in different folders have separate records", () => {
    const { home, env } = setup();
    const first = join(home, "a", "same");
    const second = join(home, "b", "same");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    expect(run(env, save(first, 0), note).status).toBe(0);
    expect(run(env, ["show", "--workspace", second]).stdout).toContain('"revision":0');
    expect(run(env, save(second, 0), note).status).toBe(0);
    expect(readdirSync(join(home, ".orch-private", "resume-v1"))).toHaveLength(2);
  });

  it("a workspace path that is or passes through a link is refused and nothing behind the link is asked for", () => {
    const { base, home, env } = layout();
    const real = join(base, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    writeFileSync(join(real, "canary.txt"), CANARY);
    writeFileSync(join(real, "inner", "canary.txt"), CANARY);
    const link = join(base, "link");
    privateLink(real, link);
    const behind = snapshot(real);

    // Control: the same folder named without a link is accepted, and the record of calls shows the
    // command asking about it. Its private folders are made in a home of its own.
    const control = layout();
    const plain = traced(base, control.env, ["show", "--workspace", join(real, "inner")]);
    expect({ status: plain.status, stdout: plain.stdout }).toEqual({ status: 0, stdout: `${JSON.stringify({ status: "absent", revision: 0 })}\n` });
    expect(through(plain.calls, real)).not.toEqual([]);

    for (const workspace of [link, join(link, "inner")]) {
      for (const [name, args, input] of commands(workspace, 0)) {
        const result = traced(base, env, args, input);
        // The command looked at the link itself, without following it, and asked for nothing through it.
        expect(result.calls).toContainEqual({ op: "lstatSync", paths: [link] });
        expect(through(result.calls, link)).toEqual([]);
        expect(through(result.calls, real)).toEqual([]);
        expect({ name, workspace, status: result.status, stdout: result.stdout, stderr: result.stderr })
          .toEqual({ name, workspace, status: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: "workspace or home is unavailable" })}\n` });
      }
    }
    expect(snapshot(real)).toEqual(behind);
    expect(readdirSync(home)).toEqual([]);
  });

  // Where the system's own temporary folder is reached through a link, as on macOS, a workspace
  // named through that link is refused like any other. Elsewhere there is nothing to test.
  it.runIf(tmpdir() !== realpathSync(tmpdir()))("a workspace named through the system temporary folder's own link is refused", () => {
    const { base, home, env } = layout();
    const unresolved = join(tmpdir(), base.slice(realpathSync(tmpdir()).length + 1), "work");
    expect(realpathSync(unresolved)).toBe(join(base, "work"));
    for (const [name, args, input] of commands(unresolved, 0)) {
      const result = run(env, args, input);
      expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ name, status: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: "workspace or home is unavailable" })}\n` });
    }
    expect(readdirSync(home)).toEqual([]);
    // The same folder by its link-free path is accepted.
    expect(run(env, save(join(base, "work"), 0), note).status).toBe(0);
  });

  it.each(["the private root", "the versioned folder", "the workspace folder"])("a link in place of %s is refused and nothing is read or written through it", (level) => {
    const { base, home, workspace, outside, env } = layout();
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(CANARY))).status).toBe(0);
    const root = join(home, ".orch-private");
    const versioned = join(root, "resume-v1");
    const folder = join(versioned, readdirSync(versioned)[0]);
    const linked = level === "the private root" ? root : level === "the versioned folder" ? versioned : folder;

    // Control: while nothing is linked, show reads the record, and the record of calls shows it going through this folder.
    const control = traced(base, env, ["show", "--workspace", workspace]);
    expect(JSON.parse(control.stdout)).toMatchObject({ status: "unverified", revision: 1, note: noteOf(CANARY) });
    expect(through(control.calls, linked)).not.toEqual([]);

    // The real folder, with its valid record, moves outside; a link takes its place.
    const target = join(outside, "moved");
    renameSync(linked, target);
    privateLink(target, linked);
    const behind = snapshot(outside);
    expect(behind.join("\n")).toContain(Buffer.from(CANARY).toString("hex"));

    for (const [name, args, input] of commands(workspace, 1)) {
      const result = traced(base, env, args, input);
      // The command looked at the link itself, without following it, and asked for nothing through it.
      expect(result.calls).toContainEqual({ op: "lstatSync", paths: [linked] });
      expect(through(result.calls, linked)).toEqual([]);
      expect(through(result.calls, outside)).toEqual([]);
      expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ name, status: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: "unsafe storage directory" })}\n` });
    }
    expect(snapshot(outside)).toEqual(behind);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it.each(["a symbolic link", "a second hard link"])("a record that is %s is refused and the file behind it is not opened", (kind) => {
    const { base, home, workspace, outside, env } = layout();
    expect(run(env, save(workspace, 0), JSON.stringify(noteOf(CANARY))).status).toBe(0);
    const directory = stateDirectory(home);
    const state = join(directory, "state.json");

    // Control: a plain record is opened and read, and the record of calls shows it.
    const control = traced(base, env, ["show", "--workspace", workspace]);
    expect(JSON.parse(control.stdout)).toMatchObject({ status: "unverified", revision: 1, note: noteOf(CANARY) });
    expect(through(control.calls, state)).not.toEqual([]);

    const canary = join(outside, "canary.json");
    if (kind === "a symbolic link") { renameSync(state, canary); privateLink(canary, state); } else linkSync(state, canary);
    const behind = snapshot(outside);
    const inside = snapshot(directory);
    expect(behind.join("\n")).toContain(Buffer.from(CANARY).toString("hex"));

    for (const [name, args, input] of commands(workspace, 1)) {
      const result = traced(base, env, args, input);
      // The record's own entry was opened without following it and checked through that descriptor.
      expect(result.calls).toContainEqual({ op: "openSync", paths: [state] });
      expect(through(result.calls, outside)).toEqual([]);
      expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ name, status: 4, stdout: "", stderr: `${JSON.stringify({ status: "unavailable", message: "unsafe state file" })}\n` });
    }
    expect(snapshot(outside)).toEqual(behind);
    expect(snapshot(directory)).toEqual(inside);
  });
});

test("forget removes body and old revision cannot resurrect it", () => {
  const { home, env, workspace } = setup();
  expect(run(env, save(workspace, 0), note).status).toBe(0);
  expect(run(env, ["forget", "--workspace", workspace, "--expected-revision", "1"]).status).toBe(0);
  expect(run(env, save(workspace, 1), note).status).toBe(3);
  const directory = stateDirectory(home);
  expect(readdirSync(directory)).toEqual(["state.json"]);
  expect(readFileSync(join(directory, "state.json"), "utf8")).not.toContain("goal");
  expect(JSON.parse(run(env, ["show", "--workspace", workspace]).stdout)).toEqual({ status: "absent", revision: 2 });
});

test.skipIf(process.platform === "win32")("a record replaced by a link immediately before open is refused without reading its target", () => {
  const { home, env, workspace } = setup();
  expect(run(env, save(workspace, 0), note).status).toBe(0);
  const state = join(stateDirectory(home), "state.json");
  const outside = join(home, "outside.json");
  const outsideRecord = {
    schema: 1,
    id: "00000000-0000-4000-8000-000000000000",
    revision: 77,
    saved_at: new Date().toISOString(),
    note: noteOf(CANARY),
  };
  writeFileSync(outside, `${JSON.stringify(outsideRecord)}\n`);
  const outsideBefore = readFileSync(outside);
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    expect(() => show(workspace, { beforeRecordOpen: (path) => {
      expect(path).toBe(state);
      rmSync(state);
      symlinkSync(outside, state);
    } })).toThrow("unsafe state file");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  }
  expect(readFileSync(outside)).toEqual(outsideBefore);
});
