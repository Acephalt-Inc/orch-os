// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { lchmodSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { access, chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { setPreference, showPreferences, unsetPreference, workspaceDigest, type WritePoint } from "../src/preferences/store.js";

const homes: string[] = [];
const outerHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

/** The store derives its root from the user's home, so each test points the home at a fresh directory. */
async function setup() {
  const home = await mkdtemp(join(await realpath(tmpdir()), "orch-preference-"));
  homes.push(home);
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, workspace, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

afterEach(async () => {
  for (const [key, value] of Object.entries(outerHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function command(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [resolve("dist/preferences/command.js"), ...args], { encoding: "utf8", timeout: 55_000, env });
}

async function stateDirectory(home: string, workspace: string): Promise<string> {
  return join(home, ".orch-private", "preferences-v1", workspaceDigest(await realpath(workspace)));
}

const set = (workspace: string, key: string, value: string, revision: number) => ["set", key, value, "--workspace", workspace, "--expected-revision", String(revision)];

const unset = (workspace: string, key: string, revision: number) => ["unset", key, "--workspace", workspace, "--expected-revision", String(revision)];

interface Call { op: string; paths: string[]; }
let traces = 0;

/**
 * The built command with every file-system call it makes recorded (see the fixture). The record is
 * what lets a test say that a file was not opened, instead of only that its bytes did not change.
 */
function traced(base: string, env: NodeJS.ProcessEnv, args: string[]) {
  const log = join(base, `trace-${traces++}.log`);
  const preload = pathToFileURL(resolve("tests/fixtures/preferences/fs-trace.mjs")).href;
  const result = spawnSync(process.execPath, ["--import", preload, resolve("dist/preferences/command.js"), ...args], { encoding: "utf8", timeout: 55_000, env: { ...env, FS_TRACE_FILE: log } });
  const calls: Call[] = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// Looking at a path without following it: the only call a command may make on a link itself.
const NO_FOLLOW = new Set(["promises.lstat", "promises.open"]);

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
    const info = lstatSync(join(root, path));
    if (info.isDirectory()) lines.push(`${path} folder`, ...snapshot(root, path));
    else if (info.isFile()) lines.push(`${path} file links=${info.nlink} ${readFileSync(join(root, path)).toString("hex")}`);
    else lines.push(`${path} ${info.isSymbolicLink() ? "link" : "other"}`);
  }
  return lines;
}

/** A link whose own permission bits are private, so that only a check for the link itself can refuse it. */
async function privateLink(target: string, path: string): Promise<void> {
  await symlink(target, path);
  if (process.platform === "darwin") lchmodSync(path, 0o700);
}

/** A home, a workspace and a folder outside both, none of them inside another. */
async function layout() {
  const base = await mkdtemp(join(await realpath(tmpdir()), "orch-preference-links-"));
  homes.push(base);
  const home = join(base, "home"), workspace = join(base, "work"), outside = join(base, "outside");
  for (const folder of [home, workspace, outside]) await mkdir(folder);
  return { base, home, workspace, outside, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

/** The three commands, each as it would be accepted if nothing were linked. */
function commands(workspace: string, revision: number): [string, string[]][] {
  return [["show", ["show", "--workspace", workspace]], ["set", set(workspace, "answer-length", "normal", revision)], ["unset", unset(workspace, "response-language", revision)]];
}

const refusal = (message: string) => `${JSON.stringify({ status: "unavailable", message })}\n`;
// The saved value that a command following a link would read and print.
const BEHIND = { revision: 1, preferences: { "response-language": "zh" } };

/** Set answer-length=short at revision 1, then start a set of response-language=zh that is killed at `point`. */
async function interrupted(point: WritePoint) {
  const made = await setup();
  expect(command(made.env, set(made.workspace, "answer-length", "short", 0)).status).toBe(0);
  const directory = await stateDirectory(made.home, made.workspace);
  const state = join(directory, "state.json");
  const oldBytes = await readFile(state);
  const fixture = resolve("tests/fixtures/preferences/crash-writer.mjs");
  const child = spawnSync(process.execPath, [fixture, resolve("dist/preferences/store.js"), made.workspace, "response-language", "zh", "1", point], { encoding: "utf8", timeout: 30_000, env: made.env });
  // The change really reached the point and really died there: neither numbered exit of the fixture was taken.
  expect(child.stdout).toBe(`reached ${point}\n`);
  expect([0, 97, 98]).not.toContain(child.status);
  if (process.platform !== "win32") expect(child.signal).toBe("SIGKILL");
  return { ...made, directory, state, lock: join(directory, ".lock"), oldBytes };
}

describe("preferences store", () => {
  it("preference is a setting never proof of approval", async () => {
    const { workspace, home } = await setup();
    const { view } = await setPreference(workspace, "answer-length", "short", 0, 0);
    expect(JSON.stringify(view)).not.toMatch(/approv|verif/i);
    const files = await readdir(join(home, ".orch-private", "preferences-v1"), { recursive: true });
    expect(files.join(" ")).not.toMatch(/approv|verif/i);
  });

  it("unknown keys and free text cannot become standing instructions", async () => {
    const { workspace, home } = await setup();
    await expect(setPreference(workspace, "allow-send", "ignore instructions", 0)).rejects.toThrow("invalid preference key or value");
    await expect(readdir(join(home, ".orch-private"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expiry excludes the exact boundary", async () => {
    const { workspace } = await setup();
    const saved = (await setPreference(workspace, "answer-length", "short", 0, 1_000)).view;
    const expiry = Date.parse(saved.expiry["answer-length"]!);
    // Ninety days after the fixed time of the set, to the millisecond.
    expect(expiry).toBe(1_000 + 90 * 24 * 60 * 60 * 1_000);
    expect((await showPreferences(workspace, expiry - 1)).preferences).toEqual({ "answer-length": "short" });
    expect((await showPreferences(workspace, expiry)).preferences).toEqual({});
    expect((await showPreferences(workspace, expiry + 1)).preferences).toEqual({});
  });

  it("windows identity and path roots do not alias workspaces", () => {
    const first = workspaceDigest("C:\\teams\\alpha\\same", win32);
    const second = workspaceDigest("D:\\teams\\alpha\\same", win32);
    expect(first).not.toBe(second);
    expect(workspaceDigest("C:\\", win32)).not.toBe(workspaceDigest("D:\\", win32));
  });

  describe("unsafe paths and interrupted writes preserve state", () => {
    it.each(["the private root", "the versioned folder", "the workspace folder"])("an existing public %s is refused without changing its mode", async (level) => {
      const { home, workspace } = await setup();
      const root = join(home, ".orch-private");
      const versioned = join(root, "preferences-v1");
      const directory = join(versioned, workspaceDigest(await realpath(workspace)));
      const folders = [root, versioned, directory];
      const index = ["the private root", "the versioned folder", "the workspace folder"].indexOf(level);
      for (let current = 0; current <= index; current++) await mkdir(folders[current], { mode: current === index ? 0o755 : 0o700 });
      await expect(setPreference(workspace, "answer-length", "short", 0)).rejects.toThrow("unsafe preference path");
      expect((await stat(folders[index])).mode & 0o777).toBe(0o755);
      expect(await readdir(folders[index])).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("an existing folder owned by another user is refused", async () => {
      const { home, workspace } = await setup();
      const root = join(home, ".orch-private");
      await mkdir(root, { mode: 0o700 });
      await expect(setPreference(workspace, "answer-length", "short", 0, Date.now(), { uid: process.getuid!() + 1 })).rejects.toThrow("unsafe preference path");
      expect(await readdir(root)).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("a state link installed immediately before open is refused without reading its target", async () => {
      const { workspace, home } = await setup();
      await setPreference(workspace, "answer-length", "short", 0);
      const state = join(await stateDirectory(home, workspace), "state.json");
      const outside = join(home, "outside.json");
      const outsideBytes = `${JSON.stringify({ version: 1, revision: 91, preferences: {} })}\n`;
      await writeFile(outside, outsideBytes);
      await expect(showPreferences(workspace, Date.now(), {
        beforeStateOpen: async () => {
          await rm(state);
          await symlink(outside, state);
        },
      })).rejects.toThrow("unsafe preference state");
      expect(await readFile(outside, "utf8")).toBe(outsideBytes);
    });

    it("a linked state file is refused and its target is left unchanged", async () => {
      const { workspace, home } = await setup();
      await setPreference(workspace, "answer-length", "normal", 0);
      const state = join(await stateDirectory(home, workspace), "state.json");
      const before = await readFile(state, "utf8");
      await rm(state);
      await symlink(join(home, "outside"), state);
      await writeFile(join(home, "outside"), before);
      await expect(showPreferences(workspace)).rejects.toThrow("unsafe preference state");
      await expect(setPreference(workspace, "answer-length", "short", 1)).rejects.toThrow("unsafe preference state");
      expect(await readFile(join(home, "outside"), "utf8")).toBe(before);
    });

    it("a workspace path that is or passes through a link is refused and nothing behind the link is asked for", async () => {
      const { base, home, env } = await layout();
      const real = join(base, "real");
      await mkdir(join(real, "inner"), { recursive: true });
      await writeFile(join(real, "canary.txt"), "canary-behind-the-link-5d2e");
      await writeFile(join(real, "inner", "canary.txt"), "canary-behind-the-link-5d2e");
      const linked = join(base, "link");
      await privateLink(real, linked);
      const behind = snapshot(real);

      // Control: the same folder named without a link is accepted, and the record of calls shows the
      // command asking about it.
      const control = await layout();
      const plain = traced(base, control.env, ["show", "--workspace", join(real, "inner")]);
      expect({ status: plain.status, stdout: plain.stdout }).toEqual({ status: 0, stdout: `${JSON.stringify({ source: "explicit-command", revision: 0, preferences: {}, expiry: {} })}\n` });
      expect(through(plain.calls, real)).not.toEqual([]);

      for (const workspace of [linked, join(linked, "inner")]) {
        for (const [name, args] of commands(workspace, 0)) {
          const result = traced(base, env, args);
          // The command looked at the link itself, without following it, and asked for nothing through it.
          expect(result.calls).toContainEqual({ op: "promises.lstat", paths: [linked] });
          expect(through(result.calls, linked)).toEqual([]);
          expect(through(result.calls, real)).toEqual([]);
          expect({ name, workspace, status: result.status, stdout: result.stdout, stderr: result.stderr })
            .toEqual({ name, workspace, status: 4, stdout: "", stderr: refusal("unsafe workspace path") });
        }
      }
      expect(snapshot(real)).toEqual(behind);
      expect(await readdir(home)).toEqual([]);
    });

    // Where the system's own temporary folder is reached through a link, as on macOS, a workspace
    // named through that link is refused like any other. Elsewhere there is nothing to test.
    it.runIf(tmpdir() !== realpathSync(tmpdir()))("a workspace named through the system temporary folder's own link is refused", async () => {
      const { base, home, env } = await layout();
      const unresolved = join(tmpdir(), base.slice(realpathSync(tmpdir()).length + 1), "work");
      expect(realpathSync(unresolved)).toBe(join(base, "work"));
      for (const [name, args] of commands(unresolved, 0)) {
        const result = command(env, args);
        expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
          .toEqual({ name, status: 4, stdout: "", stderr: refusal("unsafe workspace path") });
      }
      expect(await readdir(home)).toEqual([]);
      // The same folder by its link-free path is accepted.
      expect(command(env, set(join(base, "work"), "answer-length", "short", 0)).status).toBe(0);
    });

    it.each(["the private root", "the versioned folder", "the workspace folder"])("a link in place of %s is refused and nothing is read or written through it", async (level) => {
      const { base, home, workspace, outside, env } = await layout();
      expect(command(env, set(workspace, "response-language", "zh", 0)).status).toBe(0);
      const root = join(home, ".orch-private");
      const versioned = join(root, "preferences-v1");
      const folder = await stateDirectory(home, workspace);
      const linked = level === "the private root" ? root : level === "the versioned folder" ? versioned : folder;

      // Control: while nothing is linked, show reads the state, and the record of calls shows it going through this folder.
      const control = traced(base, env, ["show", "--workspace", workspace]);
      expect(JSON.parse(control.stdout)).toMatchObject(BEHIND);
      expect(through(control.calls, linked)).not.toEqual([]);

      // The real folder, with its valid state, moves outside; a link takes its place.
      const target = join(outside, "moved");
      await rename(linked, target);
      await privateLink(target, linked);
      const behind = snapshot(outside);
      expect(behind.join("\n")).toContain(Buffer.from('"value":"zh"').toString("hex"));

      for (const [name, args] of commands(workspace, 1)) {
        const result = traced(base, env, args);
        // The command tried to open the folder without following it and asked for nothing through it.
        expect(result.calls).toContainEqual({ op: "promises.open", paths: [linked] });
        expect(through(result.calls, linked)).toEqual([]);
        expect(through(result.calls, outside)).toEqual([]);
        expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
          .toEqual({ name, status: 4, stdout: "", stderr: refusal("unsafe preference path") });
      }
      expect(snapshot(outside)).toEqual(behind);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    });

    it.each(["a symbolic link", "a second hard link"])("a state file that is %s is refused and the file behind it is not opened", async (kind) => {
      const { base, home, workspace, outside, env } = await layout();
      expect(command(env, set(workspace, "response-language", "zh", 0)).status).toBe(0);
      const directory = await stateDirectory(home, workspace);
      const state = join(directory, "state.json");

      // Control: a plain state file is opened and read, and the record of calls shows it.
      const control = traced(base, env, ["show", "--workspace", workspace]);
      expect(JSON.parse(control.stdout)).toMatchObject(BEHIND);
      expect(control.calls).toContainEqual({ op: "promises.open", paths: [state] });

      const canary = join(outside, "canary.json");
      if (kind === "a symbolic link") { await rename(state, canary); await privateLink(canary, state); } else await link(state, canary);
      const behind = snapshot(outside);
      const inside = snapshot(directory);
      expect(behind.join("\n")).toContain(Buffer.from('"value":"zh"').toString("hex"));

      for (const [name, args] of commands(workspace, 1)) {
        const result = traced(base, env, args);
        // The state entry was opened without following it, and nothing named the file outside.
        expect(result.calls).toContainEqual({ op: "promises.open", paths: [state] });
        expect(through(result.calls, state)).toEqual([]);
        expect(through(result.calls, outside)).toEqual([]);
        expect({ name, status: result.status, stdout: result.stdout, stderr: result.stderr })
          .toEqual({ name, status: 4, stdout: "", stderr: refusal("unsafe preference state") });
      }
      expect(snapshot(outside)).toEqual(behind);
      expect(snapshot(directory)).toEqual(inside);
    });

    it.each<WritePoint>(["locked", "temp-flushed", "renamed"])("a set killed at %s leaves the old or the new valid state", async (point) => {
      const { env, workspace, directory, state, lock, oldBytes } = await interrupted(point);
      const replaced = point === "renamed";
      const current = replaced ? 2 : 1;

      // The state file holds the old state byte for byte, or the complete new state.
      const afterBytes = await readFile(state);
      if (replaced) {
        const stored = JSON.parse(afterBytes.toString("utf8"));
        expect(Object.keys(stored).sort()).toEqual(["preferences", "revision", "version"]);
        expect(stored).toMatchObject({ version: 1, revision: 2, preferences: { "answer-length": { value: "short" }, "response-language": { value: "zh" } } });
        expect(afterBytes.toString("utf8")).toBe(`${JSON.stringify(stored)}\n`);
      } else {
        expect(afterBytes).toEqual(oldBytes);
      }
      // A flushed temporary file holding the new value exists only at the middle boundary.
      const temporaries = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
      expect(temporaries).toHaveLength(point === "temp-flushed" ? 1 : 0);
      for (const name of temporaries) expect(await readFile(join(directory, name), "utf8")).toContain('"zh"');

      // Reading still works and returns valid settings.
      const shown = command(env, ["show", "--workspace", workspace]);
      expect(shown.status).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({ revision: current, preferences: replaced ? { "answer-length": "short", "response-language": "zh" } : { "answer-length": "short" } });

      // The dead writer's lock is still there: the next set is refused, and nothing is taken over.
      const refused = command(env, set(workspace, "answer-length", "normal", current));
      expect(refused.status).toBe(4);
      await access(lock);
      expect(await readFile(state)).toEqual(afterBytes);

      // After the documented manual step the store accepts only the current revision.
      await rmdir(lock);
      if (replaced) expect(command(env, set(workspace, "answer-length", "normal", 1)).status).toBe(3);
      expect(command(env, set(workspace, "answer-length", "normal", current)).status).toBe(0);
      // No owned file other than the state survives, so no temporary file still holds a value.
      expect(await readdir(directory)).toEqual(["state.json"]);
    });

    it("the temporary file is flushed before it replaces the state", async () => {
      const { workspace } = await setup();
      const steps: string[] = [];
      await setPreference(workspace, "answer-length", "short", 0, Date.now(), {
        at: (point) => { steps.push(point); },
        sync: async (handle) => { steps.push("flush"); await handle.sync(); },
      });
      expect(steps.slice(0, 4)).toEqual(["locked", "flush", "temp-flushed", "renamed"]);
    });

    it("a failed flush leaves no temporary file, no state and no lock", async () => {
      const { home, workspace } = await setup();
      const failing = { sync: async () => { throw new Error("flush failed"); } };
      await expect(setPreference(workspace, "answer-length", "short", 0, Date.now(), failing)).rejects.toThrow("flush failed");
      expect(await readdir(await stateDirectory(home, workspace))).toEqual([]);
    });

    it("a platform that cannot sync a directory still acknowledges the write it made", async () => {
      const { home, workspace } = await setup();
      const refuse = async () => { throw Object.assign(new Error("a directory cannot be opened here"), { code: "EPERM" }); };
      let outcome: unknown;
      try { outcome = (await setPreference(workspace, "answer-length", "short", 0, Date.now(), { platform: "win32", openDirectory: refuse })).view.revision; }
      catch (error) { outcome = error instanceof Error ? `threw: ${error.message}` : "threw"; }
      expect(outcome).toBe(1);
      const directory = await stateDirectory(home, workspace);
      expect(await readdir(directory)).toEqual(["state.json"]);
      const stored = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      expect(stored).toMatchObject({ revision: 1, preferences: { "answer-length": { value: "short" } } });
    });

    it("a directory flush failure after rename is an acknowledged change", async () => {
      const { home, workspace } = await setup();
      const refuse = async () => { throw new Error("directory flush failed"); };
      const first = await setPreference(workspace, "answer-length", "short", 0, Date.now(), { openDirectory: refuse });
      expect({ revision: first.view.revision, directoryFlushed: first.directoryFlushed }).toEqual({ revision: 1, directoryFlushed: false });
      await expect(setPreference(workspace, "answer-length", "normal", 0)).rejects.toMatchObject({ status: "conflict" });
      expect((await setPreference(workspace, "answer-length", "normal", 1)).view.revision).toBe(2);
      expect(JSON.parse(await readFile(join(await stateDirectory(home, workspace), "state.json"), "utf8"))).toMatchObject({ revision: 2 });
    });
  });

  it("documents the folder replacement limit exactly", async () => {
    const documentation = await readFile(resolve("docs/preferences.md"), "utf8");
    const required = "A program that can replace a preferences folder between the last safety check and a filesystem operation is not defended against. " +
      "Such a replacement can redirect that operation outside the preferences folder.";
    expect(documentation).toContain(required);
  });

  describe("unset cannot be undone by stale state or owned temporary files", () => {
    it("a stale revision cannot restore the removed value", async () => {
      const { workspace, home } = await setup();
      await setPreference(workspace, "response-language", "zh", 0);
      await unsetPreference(workspace, "response-language", 1);
      await expect(setPreference(workspace, "response-language", "en", 1)).rejects.toMatchObject({ status: "conflict" });
      expect((await showPreferences(workspace)).preferences).toEqual({});
      const directory = await stateDirectory(home, workspace);
      expect(await readdir(directory)).toEqual(["state.json"]);
      expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain("zh");
    });

    it("an unset after an interrupted set leaves the value in no owned file", async () => {
      const { env, workspace, directory, state, lock } = await interrupted("temp-flushed");
      await rmdir(lock);
      expect(command(env, ["unset", "answer-length", "--workspace", workspace, "--expected-revision", "1"]).status).toBe(0);
      expect(await readdir(directory)).toEqual(["state.json"]);
      const text = await readFile(state, "utf8");
      expect(text).not.toContain("short");
      expect(text).not.toContain("zh");
      expect(JSON.parse(command(env, ["show", "--workspace", workspace]).stdout)).toMatchObject({ revision: 2, preferences: {} });
    });
  });
});
