// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FileLock, LockLostError, LockOwnerError, LockTimeoutError, withLock } from "../src/lock.js";
import { dumps } from "../src/pyjson.js";
import { parseToml, TomlError } from "../src/toml.js";
import { Messages } from "../src/messages.js";
import { atomicWrite } from "../src/util.js";
import { ROOT, useTmpHome, waitFor } from "./_helpers.js";

describe("LockV2", () => {
  const ctx = useTmpHome();

  it("mutual_exclusion_across_processes", async () => {
    // 6 processes x 25 read-increment-write cycles on one counter file: no lost update
    const lock = join(ctx.home, "c.lock.d");
    const counter = join(ctx.home, "counter");
    writeFileSync(counter, "0");
    const mod = pathToFileURL(join(ROOT, "dist", "lock.js")).href;
    const script = `import(${JSON.stringify(mod)}).then((m) => { const fs = require("node:fs");` +
      ` for (let i = 0; i < 25; i++) m.withLock(${JSON.stringify(lock)}, () => {` +
      ` const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")); fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1)); }); })`;
    const errors: string[] = [];
    const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise<number>((res) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk) => errors.push(String(chunk)));
      child.on("exit", (c) => res(c ?? -1));
    })));
    expect(codes, errors.join("\n")).toEqual(Array(6).fill(0));
    expect(readFileSync(counter, "utf8")).toBe("150");
    expect(existsSync(lock)).toBe(false);
  });

  it("a_lock_left_by_a_dead_process_is_broken", () => {
    const lock = join(ctx.home, "dead.lock.d");
    mkdirSync(lock);
    // pid 2^22+123 is above the default pid range on both Linux and macOS: never alive
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4194427, host: hostname(), token: "dead", created_ms: Date.now() }));
    expect(withLock(lock, () => 42, { timeoutMs: 2000 })).toBe(42);
  });

  it("an_old_lock_from_another_host_is_broken_after_stale_ms", () => {
    const lock = join(ctx.home, "old.lock.d");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: "elsewhere", token: "old", created_ms: Date.now() - 120_000 }));
    expect(withLock(lock, () => "ok", { timeoutMs: 2000 })).toBe("ok");
  });

  it("an_ownerless_lock_dir_is_broken_only_once_it_is_old", () => {
    const lock = join(ctx.home, "bare.lock.d");
    mkdirSync(lock);
    expect(() => withLock(lock, () => 1, { timeoutMs: 150, staleMs: 60_000 })).toThrow(LockTimeoutError);
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(lock, past, past);
    expect(withLock(lock, () => 2, { timeoutMs: 2000 })).toBe(2);
  });

  it("a_live_holder_blocks_until_timeout", () => {
    const lock = join(ctx.home, "live.lock.d");
    const a = new FileLock(lock);
    a.acquire();
    const t0 = Date.now();
    expect(() => new FileLock(lock, { timeoutMs: 200 }).acquire()).toThrow(LockTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    a.release();
    expect(withLock(lock, () => true)).toBe(true);
  });

  it("an_old_live_local_pid_is_never_stale_by_age", () => {
    const path = join(ctx.home, "paused.lock.d");
    const holder = new FileLock(path);
    holder.acquire();
    const file = join(path, "owner.json");
    const owner = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...owner, created_ms: 0 }));
    expect(() => withLock(path, () => { throw new Error("wrongful takeover"); }, { timeoutMs: 80, staleMs: 1 })).toThrow(LockTimeoutError);
    holder.assertHeld();
    holder.release();
  });

  it.each(["unreadable", "corrupt", "incomplete"])("unknown_owner_blocks_before_the_callback: %s", (kind) => {
    const path = join(ctx.home, "unknown.lock.d");
    mkdirSync(path);
    if (kind === "unreadable") mkdirSync(join(path, "owner.json"));
    else writeFileSync(join(path, "owner.json"), kind === "corrupt" ? "{" : '{"token":"old"}');
    const past = Date.now() / 1000 - 1000;
    utimesSync(path, past, past);
    let ran = false;
    expect(() => withLock(path, () => { ran = true; }, { timeoutMs: 50, staleMs: 1 })).toThrow(LockOwnerError);
    expect(ran).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("EACCES_owner_read_preserves_ownership_and_never_runs_callback", () => {
    const path = join(ctx.home, "denied.lock.d");
    const holder = new FileLock(path);
    holder.acquire();
    const file = join(path, "owner.json");
    const owner = readFileSync(file, "utf8");
    const past = Date.now() / 1000 - 1000;
    utimesSync(path, past, past);
    const script = `import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { withLock } from ${JSON.stringify(pathToFileURL(join(ROOT, "dist/lock.js")).href)};
      const read = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (path === ${JSON.stringify(file)}) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return read(path, ...args);
      };
      syncBuiltinESMExports();
      let callback = false, error = null;
      try { withLock(${JSON.stringify(path)}, () => { callback = true; }, { timeoutMs: 100, staleMs: 1 }); }
      catch (e) { error = e.name; }
      console.log(JSON.stringify({ callback, error }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ callback: false, error: "LockOwnerError" });
    expect(readFileSync(file, "utf8")).toBe(owner);
    holder.assertHeld();
    holder.release();
  });

  it("publication_and_stale_removal_never_let_a_displaced_holder_overwrite_its_successor", async () => {
    const lock = join(ctx.home, "schedule.lock.d");
    const dest = join(ctx.home, "protected");
    writeFileSync(dest, "old snapshot");
    const common = `import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { withLock } from ${JSON.stringify(pathToFileURL(join(ROOT, "dist/lock.js")).href)};
      import { atomicWrite } from ${JSON.stringify(pathToFileURL(join(ROOT, "dist/util.js")).href)};
      const dir = ${JSON.stringify(ctx.home)}, lock = ${JSON.stringify(lock)}, dest = ${JSON.stringify(dest)};
      function signal(name) { fs.writeFileSync(dir + "/" + name, ""); }
      function wait(name) {
        const cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 15000;
        while (!fs.existsSync(dir + "/" + name)) {
          if (Date.now() > end) throw Error("signal timeout: " + name);
          Atomics.wait(cell, 0, 0, 5);
        }
      }`;
    const aScript = common + `
      const mkdir = fs.mkdirSync, rename = fs.renameSync;
      let first = true;
      fs.mkdirSync = function(path, ...args) {
        let result;
        try { result = mkdir(path, ...args); }
        catch (e) {
          if (path === lock + ".break" && e.code === "EEXIST") {
            signal("publicationExcluded"); wait("goPublication");
          }
          throw e;
        }
        if (path === lock && first) { first = false; signal("initDir"); wait("goInit"); }
        return result;
      };
      fs.renameSync = function(from, to) {
        if (to === dest) { signal("writeChecked"); wait("goWrite"); }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      try { withLock(lock, () => atomicWrite(dest, "old snapshot"), { timeoutMs: 15000 }); }
      catch (e) { console.error(e.name); process.exitCode = 5; }`;
    const bScript = common + `
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (from === lock && to.includes(".stale.")) { signal("breakChecked"); wait("goBreak"); }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      withLock(lock, () => {
        atomicWrite(dest, "newer writer"); signal("successorWritten"); wait("goSuccessorFinish");
      }, { staleMs: 1, timeoutMs: 15000 });`;
    const children: Array<{ child: ReturnType<typeof spawn>; done: Promise<number | null>; error: () => string }> = [];
    const start = (script: string) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const entry = { child, done: new Promise<number | null>((resolve) => child.on("exit", resolve)), error: () => stderr };
      children.push(entry);
      return entry;
    };
    const signal = (name: string) => writeFileSync(join(ctx.home, name), "");
    const ready = (name: string) => existsSync(join(ctx.home, name));
    const until = async (pred: () => boolean) => expect(await waitFor(pred, 1500, 5)).toBe(true);
    try {
      const a = start(aScript);
      await until(() => ready("initDir"));
      const past = (Date.now() - 120000) / 1000;
      utimesSync(lock, past, past);
      const b = start(bScript);
      await until(() => ready("breakChecked"));
      signal("goInit");
      await until(() => ready("writeChecked") || ready("publicationExcluded"));
      // Unfixed code publishes and passes the final write check while the breaker is paused.
      if (ready("writeChecked")) {
        const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        expect(owner.pid).toBe(a.child.pid);
        expect(() => process.kill(owner.pid, 0)).not.toThrow();
      }
      signal("goBreak");
      await until(() => ready("successorWritten"));
      expect(readFileSync(dest, "utf8")).toBe("newer writer");
      signal("goPublication");
      signal("goWrite");
      expect(await a.done, a.error()).toBe(5);
      expect(a.error()).toContain("LockLostError");
      // The successor remains live until the displaced initializer has finished.
      expect(readFileSync(dest, "utf8")).toBe("newer writer");
      signal("goSuccessorFinish");
      expect(await b.done, b.error()).toBe(0);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(({ done }) => done));
    }
  });

  it.each(["changed", "unreadable", "missing"])("lost_or_unknown_owner_rejects_atomic_write_before_effect: %s", (kind) => {
    const path = join(ctx.home, "guard.lock.d");
    const dest = join(ctx.home, "protected");
    writeFileSync(dest, "original");
    expect(() => withLock(path, () => {
      const file = join(path, "owner.json");
      if (kind !== "changed") { rmSync(file); if (kind === "unreadable") mkdirSync(file); }
      else {
        const owner = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify({ ...owner, token: "replacement" }));
      }
      atomicWrite(dest, "stale effect");
    })).toThrow(kind === "unreadable" ? LockOwnerError : LockLostError);
    expect(readFileSync(dest, "utf8")).toBe("original");
    expect(existsSync(dest + `.tmp${process.pid}`)).toBe(false);
  });

  it("ownership_is_rechecked_after_preparing_the_temporary_file", () => {
    const path = join(ctx.home, "publish.lock.d");
    const dest = join(ctx.home, "protected");
    writeFileSync(dest, "original");
    const check = FileLock.prototype.assertHeld;
    let checks = 0;
    const spy = vi.spyOn(FileLock.prototype, "assertHeld").mockImplementation(function () {
      if (++checks === 2) {
        const file = join(path, "owner.json");
        const owner = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify({ ...owner, token: "replacement" }));
      }
      check.call(this);
    });
    try { expect(() => withLock(path, () => atomicWrite(dest, "stale"))).toThrow(LockLostError); }
    finally { spy.mockRestore(); }
    expect(readFileSync(dest, "utf8")).toBe("original");
    expect(readFileSync(dest + `.tmp${process.pid}`, "utf8")).toBe("stale");
  });

  it("a_lost_token_rejects_direct_message_append_before_effect", () => {
    const messages = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    messages.send("a", "b", "DONE", "original");
    const before = readFileSync(messages.path, "utf8");
    const all = Messages.prototype.all;
    const spy = vi.spyOn(Messages.prototype, "all").mockImplementation(function () {
      const rows = all.call(this);
      const file = this.lock + "/owner.json";
      const owner = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...owner, token: "replacement" }));
      return rows;
    });
    try { expect(() => messages.send("a", "b", "DONE", "stale")).toThrow(LockLostError); }
    finally { spy.mockRestore(); }
    expect(readFileSync(messages.path, "utf8")).toBe(before);
  });

  it("release_refuses_to_remove_a_lock_someone_else_now_holds", () => {
    const lock = join(ctx.home, "lost.lock.d");
    const a = new FileLock(lock);
    a.acquire();
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token: "other", created_ms: Date.now() }));
    expect(() => a.release()).toThrow(LockLostError);
    expect(existsSync(lock)).toBe(true);
  });

  it("an_exception_in_the_critical_section_still_releases", () => {
    const lock = join(ctx.home, "ex.lock.d");
    expect(() => withLock(lock, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  it("a_leftover_v1_lock_file_does_not_block", () => {
    writeFileSync(join(ctx.home, "lease.json.lock"), ""); // what v1.1 flock left behind
    expect(withLock(join(ctx.home, "lease.json.lock.d"), () => "free")).toBe("free");
  });
});

describe("TomlV2", () => {
  it("prototype_keys_are_rejected_and_never_reach_object_prototype", () => {
    for (const src of ["[__proto__]\nx = 1\n", "a.__proto__.x = 1\n", "t = { __proto__ = { x = 1 } }\n", "[agents.constructor]\n"]) {
      expect(() => parseToml(src)).toThrow(TomlError);
    }
    expect(({} as any).x).toBeUndefined();
    expect(parseToml("[a]\ntoString = 1\n")).toEqual({ a: { toString: 1 } });
  });

  it("parses_tables_inline_tables_arrays_and_scalars", () => {
    const t = parseToml(`# c
top = 1
[a]
s = "q\\"x\\u00e9"   # trailing comment
lit = 'C:\\path'
n = -1_000
f = 1.5e3
yes = true
arr = [
  "x", # one
  "y",
]
inl = { k = 1, "q k" = "v" }
[a.b.c]
d.e = "dotted"
[agents.mine]
command = ["/bin/cat"]
`);
    expect(t.top).toBe(1);
    expect(t.a.b.c.d.e).toBe("dotted");
    expect(t.a.inl).toEqual({ k: 1, "q k": "v" });
    expect(t.agents.mine.command).toEqual(["/bin/cat"]);
    expect([t.a.n, t.a.f, t.a.yes, t.a.s, t.a.lit]).toEqual([-1000, 1500, true, 'q"x\u00e9', "C:\\path"]);
  });

  it("rejects_malformed_and_unsupported_input", () => {
    for (const bad of ["x = [", "x = 1\nx = 2", "[t]\n[t]", 'x = """a"""', "x = 2026-01-01", "[[t]]", "x = nope", "x = 'a", "= 1", 'x = "a\\q"']) {
      expect(() => parseToml(bad), bad).toThrow(TomlError);
    }
  });
});

describe("PyJsonV2", () => {
  it("matches_python_json_dumps_layout", () => {
    expect(dumps({ a: 1, b: [1, "x"], c: null, d: true, e: "\u00e9\n", f: {} , g: [] })).toBe(
      '{"a": 1, "b": [1, "x"], "c": null, "d": true, "e": "\\u00e9\\n", "f": {}, "g": []}');
    expect(dumps({ a: [1, { b: 2 }] }, 1)).toBe('{\n "a": [\n  1,\n  {\n   "b": 2\n  }\n ]\n}');
  });
});
