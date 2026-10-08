// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn } from "node:child_process";
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
import { ROOT, useTmpHome } from "./_helpers.js";

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
