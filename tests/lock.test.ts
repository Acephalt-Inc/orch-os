// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

  it.each(["dead local", "old foreign", "ownerless"])("abandoned_locks_require_quiescent_reset: %s", (kind) => {
    const lock = join(ctx.home, "abandoned.lock.d");
    mkdirSync(lock);
    if (kind !== "ownerless") writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: 4194427, host: kind === "old foreign" ? "elsewhere" : hostname(), token: "dead", created_ms: 0,
    }));
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(lock, past, past);
    let callbacks = 0;
    expect(() => withLock(lock, () => ++callbacks, { timeoutMs: 80, staleMs: 1 })).toThrow(kind === "ownerless" ? LockOwnerError : LockTimeoutError);
    expect(callbacks).toBe(0);
    expect(existsSync(lock)).toBe(true);
    // All lock users are stopped, launches disabled; remove only the named lock directory.
    rmSync(lock, { recursive: true });
    expect(withLock(lock, () => ++callbacks)).toBe(1);
    expect(existsSync(lock)).toBe(false);
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

  it("a_dangling_owner_symlink_is_unknown_not_missing", () => {
    const path = join(ctx.home, "dangling.lock.d"), file = join(path, "owner.json");
    mkdirSync(path);
    symlinkSync(join(ctx.home, "missing"), file);
    let ran = false, error: any;
    try { withLock(path, () => { ran = true; }, { timeoutMs: 50 }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(LockOwnerError);
    expect(error.message).toContain(file + " (ENOENT)"); // refused at the read, not as a directory without a record
    expect(ran).toBe(false);
    // The same link under a holder is an unknown owner, not a lost lock.
    const held = join(ctx.home, "held.lock.d"), dest = join(ctx.home, "protected");
    writeFileSync(dest, "original");
    expect(() => withLock(held, () => {
      rmSync(join(held, "owner.json"));
      symlinkSync(join(ctx.home, "missing"), join(held, "owner.json"));
      atomicWrite(dest, "late effect");
    })).toThrow(LockOwnerError);
    expect(readFileSync(dest, "utf8")).toBe("original");
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

describe("LockRecovery", () => {
  const ctx = useTmpHome();
  const mod = pathToFileURL(join(ROOT, "dist/lock.js")).href;
  const util = pathToFileURL(join(ROOT, "dist/util.js")).href;
  const cli = pathToFileURL(join(ROOT, "dist/cli.js")).href;
  const base = () => `import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { withLock } from ${JSON.stringify(mod)};
    import { atomicWrite } from ${JSON.stringify(util)};
    const dir = ${JSON.stringify(ctx.home)}, lock = dir + "/schedule.lock.d", dest = dir + "/protected";
    function signal(name) { fs.writeFileSync(dir + "/" + name, "ready"); }
    function wait(name) {
      const cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 15000;
      while (!fs.existsSync(dir + "/" + name)) {
        if (Date.now() > end) throw Error("signal timeout: " + name);
        Atomics.wait(cell, 0, 0, 5);
      }
    }`;
  function start(script: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    return { child, done: new Promise<number | null>((resolve) => child.on("exit", resolve)), out: () => out, err: () => err };
  }
  async function ready(name: string) {
    expect(await waitFor(() => existsSync(join(ctx.home, name)), 5000, 5), name).toBe(true);
  }
  const signal = (name: string) => writeFileSync(join(ctx.home, name), "go");
  const attempt = (name: string) => base() + `
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = function(path, ...args) {
      try { return mkdir(path, ...args); }
      catch (e) { if (path === lock && e.code === "EEXIST") signal(${JSON.stringify(name)}); throw e; }
    };
    syncBuiltinESMExports();
    let callbacks = 0;
    try { withLock(lock, () => { callbacks++; atomicWrite(dest, "wrongful contender"); }, { timeoutMs: 100, staleMs: 1 }); }
    catch (e) { console.log(JSON.stringify({ callbacks, error: e.name, message: e.message })); process.exitCode = e.name === "LockOwnerError" ? 6 : 2; }`;
  function assertRefusal(entry: ReturnType<typeof start>, ownerless: boolean) {
    const r = JSON.parse(entry.out());
    expect(r.callbacks).toBe(0);
    expect(r.error).toBe(ownerless ? "LockOwnerError" : "LockTimeoutError");
    expect(r.message).toContain(join(ctx.home, "schedule.lock.d"));
    expect(r.message).toContain("stop every orch process and disable new launches");
    expect(r.message).toContain("preserve lease, epoch, author and journal files");
  }
  async function finish(entries: ReturnType<typeof start>[]) {
    for (const { child } of entries) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); }
    await Promise.all(entries.map((entry) => entry.done));
  }

  it.each(["mkdir", "temporary_owner", "linked_owner", "callback"])("dead_owner_or_initializer_is_refused_until_reset: %s", async (cut) => {
    const lock = join(ctx.home, "schedule.lock.d"), dest = join(ctx.home, "protected");
    writeFileSync(dest, "old snapshot");
    const sentinels = ["lease.json", "lease.json.epoch.max", "authors", "lease.json.recovery.jsonl"];
    for (const file of sentinels) writeFileSync(join(ctx.home, file), "preserved " + file);
    const holder = start(base() + `
      const mkdir = fs.mkdirSync, write = fs.writeFileSync, link = fs.linkSync;
      fs.mkdirSync = function(path, ...args) { const r = mkdir(path, ...args); if (path === lock && ${JSON.stringify(cut)} === "mkdir") { signal("ready"); wait("resume"); } return r; };
      fs.writeFileSync = function(path, ...args) { const r = write(path, ...args); if (String(path).startsWith(lock + "/.owner-") && ${JSON.stringify(cut)} === "temporary_owner") { signal("ready"); wait("resume"); } return r; };
      fs.linkSync = function(from, to) { const r = link(from, to); if (to === lock + "/owner.json" && ${JSON.stringify(cut)} === "linked_owner") { signal("ready"); wait("resume"); } return r; };
      syncBuiltinESMExports();
      withLock(lock, () => { signal("callback-entered"); if (${JSON.stringify(cut)} === "callback") { signal("ready"); wait("resume"); } atomicWrite(dest, "holder effect"); });`);
    const entries = [holder];
    try {
      await ready("ready");
      expect(existsSync(join(ctx.home, "callback-entered"))).toBe(cut === "callback");
      const past = Date.now() / 1000 - 120;
      utimesSync(lock, past, past);
      const live = start(attempt("live-attempt")); entries.push(live);
      await ready("live-attempt");
      expect(await live.done, live.err()).toBe(["mkdir", "temporary_owner"].includes(cut) ? 6 : 2);
      assertRefusal(live, ["mkdir", "temporary_owner"].includes(cut));
      expect(holder.child.kill("SIGKILL")).toBe(true);
      await holder.done;
      expect(holder.child.signalCode).toBe("SIGKILL");
      for (let i = 0; i < 2; i++) {
        const contender = start(attempt("dead-attempt-" + i)); entries.push(contender);
        await ready("dead-attempt-" + i);
        expect(await contender.done, contender.err()).toBe(["mkdir", "temporary_owner"].includes(cut) ? 6 : 2);
        assertRefusal(contender, ["mkdir", "temporary_owner"].includes(cut));
        expect(readFileSync(dest, "utf8")).toBe("old snapshot");
        expect(existsSync(lock)).toBe(true);
      }
      // Every child has exited. Disable launches in this schedule, remove only the named lock.
      rmSync(lock, { recursive: true });
      const reset = start(base() + `let callbacks = 0; withLock(lock, () => { callbacks++; atomicWrite(dest, "after reset"); }); console.log(callbacks);`);
      entries.push(reset);
      expect(await reset.done, reset.err()).toBe(0);
      expect(reset.out().trim()).toBe("1");
      expect(readFileSync(dest, "utf8")).toBe("after reset");
      expect(existsSync(lock)).toBe(false);
      for (const file of sentinels) expect(readFileSync(join(ctx.home, file), "utf8")).toBe("preserved " + file);
    } finally { await finish(entries); }
  });

  it.each(["initializer", "callback"])("paused_live_owner_is_never_reclaimed: %s", async (stage) => {
    const lock = join(ctx.home, "schedule.lock.d"), dest = join(ctx.home, "protected");
    writeFileSync(dest, "old snapshot");
    const holder = start(base() + `
      const mkdir = fs.mkdirSync;
      fs.mkdirSync = function(path, ...args) { const r = mkdir(path, ...args); if (path === lock && ${JSON.stringify(stage)} === "initializer") { signal("ready"); wait("resume"); } return r; };
      syncBuiltinESMExports();
      let callbacks = 0;
      withLock(lock, () => { callbacks++; signal("callback-entered"); if (${JSON.stringify(stage)} === "callback") { signal("ready"); wait("resume"); } atomicWrite(dest, "old snapshot"); });
      console.log(callbacks);`);
    const entries = [holder];
    try {
      await ready("ready");
      expect(holder.child.kill("SIGSTOP")).toBe(true);
      const past = Date.now() / 1000 - 120;
      utimesSync(lock, past, past);
      if (stage === "callback") {
        const file = lock + "/owner.json", owner = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify({ ...owner, created_ms: 0 }));
      }
      // Two acknowledged contenders replace the former initializer/two-breaker schedule.
      const contenders = [start(attempt("attempt-a")), start(attempt("attempt-b"))]; entries.push(...contenders);
      await ready("attempt-a"); await ready("attempt-b");
      for (const contender of contenders) {
        expect(await contender.done, contender.err()).toBe(stage === "initializer" ? 6 : 2);
        assertRefusal(contender, stage === "initializer");
      }
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe("old snapshot");
      signal("resume"); holder.child.kill("SIGCONT");
      expect(await holder.done, holder.err()).toBe(0);
      expect(holder.out().trim()).toBe("1");
      expect(existsSync(lock)).toBe(false);
      const successor = start(base() + `let callbacks = 0; withLock(lock, () => { callbacks++; atomicWrite(dest, "newer writer"); signal("successor-written"); wait("successor-release"); }); console.log(callbacks);`);
      entries.push(successor);
      await ready("successor-written");
      expect(readFileSync(dest, "utf8")).toBe("newer writer");
      signal("successor-release");
      expect(await successor.done, successor.err()).toBe(0);
      expect(successor.out().trim()).toBe("1");
      expect(readFileSync(dest, "utf8")).toBe("newer writer");
      expect(existsSync(lock)).toBe(false);
    } finally { await finish(entries); }
  });

  it.each(["ownerless", "corrupt", "legacy"])("unknown_owner_and_legacy_artifacts_block: %s", (kind) => {
    const lock = join(ctx.home, "schedule.lock.d"), dest = join(ctx.home, "protected");
    writeFileSync(dest, "old snapshot");
    const artifact = kind === "legacy" ? lock + ".break" : lock;
    mkdirSync(artifact);
    if (kind === "corrupt") writeFileSync(lock + "/owner.json", "{");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", attempt("attempt")], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(6);
    const r = JSON.parse(child.stdout);
    expect(r.callbacks).toBe(0);
    expect(r.message).toContain(artifact);
    expect(r.message).toContain("stop every orch process and disable new launches");
    expect(r.message).toContain("remove the named lock directory " + artifact);
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("old snapshot");
    if (kind === "legacy") expect(existsSync(lock)).toBe(false);
  });

  // Hooks affect built Node modules through syncBuiltinESMExports, not Vitest mocks.
  function faultScript(mode: string, errno: string, callbackFails: boolean, useCli: boolean) {
    return base() + `
      const mode = ${JSON.stringify(mode)}, errno = ${JSON.stringify(errno)};
      const targetLock = ${useCli ? 'dir + "/lease.json.lock.d"' : 'lock'};
      const unlink = fs.unlinkSync, rmdir = fs.rmdirSync, rename = fs.renameSync, write = fs.writeFileSync;
      function fail(path) { signal("fault-ready"); fs.writeFileSync(dir + "/fault-path", path); throw Object.assign(Error("injected cleanup " + errno), { code: errno }); }
      fs.writeFileSync = function(path, ...args) {
        if (mode === "acquisition_rmdir" && String(path).startsWith(targetLock + "/.owner-")) throw Object.assign(Error("initialization ENOSPC"), { code: "ENOSPC" });
        return write(path, ...args);
      };
      fs.unlinkSync = function(path, ...args) {
        if (mode === "acquisition_unlink" && String(path).startsWith(targetLock + "/.owner-")) fail(path);
        if (mode === "release_unlink" && String(path).startsWith(targetLock + ".rel.") && String(path).endsWith("/owner.json")) fail(path);
        return unlink(path, ...args);
      };
      fs.rmdirSync = function(path, ...args) {
        if (mode === "acquisition_rmdir" && path === targetLock) fail(path);
        if (mode === "release_rmdir" && String(path).startsWith(targetLock + ".rel.")) fail(path);
        return rmdir(path, ...args);
      };
      fs.renameSync = function(from, to, ...args) {
        if (mode === "release_rename" && from === targetLock) fail(from);
        return rename(from, to, ...args);
      };
      syncBuiltinESMExports();
      ${useCli ? `const { main } = await import(${JSON.stringify(cli)}); process.exitCode = await main(["lease", "acquire", "--session", "cleanup"]);` : `
        let callbacks = 0;
        try { withLock(lock, () => { callbacks++; atomicWrite(dest, "committed effect"); ${callbackFails ? 'throw Error("callback boom");' : ''} }); }
        catch (e) { console.log(JSON.stringify({ callbacks, error: e.name, message: e.message, errors: e.errors?.map(error => error.message) })); process.exitCode = 1; }
      `}`;
  }

  it.each(["acquisition_unlink", "acquisition_rmdir", "release_unlink", "release_rmdir", "release_rename"].flatMap(mode =>
    ["EIO", "EACCES", "ENOSPC"].map(errno => ({ mode, errno }))))("cleanup_error_is_nonzero_and_names_residual_state: $mode/$errno", ({ mode, errno }) => {
    const lock = join(ctx.home, "schedule.lock.d"), dest = join(ctx.home, "protected");
    writeFileSync(dest, "old snapshot");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", faultScript(mode, errno, false, false)], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(1);
    expect(existsSync(join(ctx.home, "fault-ready"))).toBe(true);
    const r = JSON.parse(child.stdout), faultPath = readFileSync(join(ctx.home, "fault-path"), "utf8");
    const acquisition = mode.startsWith("acquisition");
    expect(r.callbacks).toBe(acquisition ? 0 : 1);
    expect(r.message).toContain("lock cleanup failed: " + mode.split("_")[1] + " " + faultPath + ": " + errno);
    expect(r.message).toContain(acquisition ? "callback not entered" : "callback completed; effects may already be committed");
    expect(r.message).toContain(mode === "release_rmdir" || mode === "acquisition_rmdir" ? "ownerless directory" : "owner record remains");
    expect(r.message).toContain("stop every orch process and disable new launches");
    expect(readFileSync(dest, "utf8")).toBe(acquisition ? "old snapshot" : "committed effect");
    const residualDir = acquisition || mode === "release_rename" ? lock : join(ctx.home, readdirSync(ctx.home).find(name => name.startsWith("schedule.lock.d.rel."))!);
    expect(existsSync(residualDir)).toBe(true);
    expect(existsSync(residualDir + "/owner.json")).toBe(!["acquisition_rmdir", "release_rmdir"].includes(mode));
    if (mode === "acquisition_unlink") expect(readdirSync(lock).filter(name => name.startsWith(".owner-")).length).toBe(1);
    const next = spawnSync(process.execPath, ["--input-type=module", "-e", attempt("next-attempt")], { encoding: "utf8", timeout: 5000 });
    if (acquisition || mode === "release_rename") {
      expect(next.status).toBe(mode === "acquisition_rmdir" ? 6 : 2);
      const refusal = JSON.parse(next.stdout);
      expect(refusal.callbacks).toBe(0);
      expect(refusal.message).toContain(lock);
      expect(refusal.message).toContain("remove the named lock directory " + lock);
      expect(readFileSync(dest, "utf8")).toBe(acquisition ? "old snapshot" : "committed effect");
    } else {
      expect(next.status, next.stderr).toBe(0);
      expect(readFileSync(dest, "utf8")).toBe("wrongful contender"); // owner's release rename already freed canonical path
      expect(existsSync(residualDir)).toBe(true);
    }
    // Verify the actual built CLI maps each cleanup I/O failure to 1.
    const init = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "init", "--no-handbook"], { encoding: "utf8", env: { ...process.env, ORCH_HOME: ctx.home } });
    expect(init.status, init.stderr).toBe(0);
    const binary = spawnSync(process.execPath, ["--input-type=module", "-e", faultScript(mode, errno, false, true)], { encoding: "utf8", timeout: 5000, env: { ...process.env, ORCH_HOME: ctx.home } });
    expect(binary.status, binary.stderr).toBe(1);
    expect(binary.stderr).toContain("lock cleanup failed");
    expect(binary.stderr).toContain(readFileSync(join(ctx.home, "fault-path"), "utf8"));
    expect(binary.stderr).toContain(errno);
    expect(binary.stderr).toContain(acquisition ? "callback not entered" : "effects may already be committed");
    expect(existsSync(join(ctx.home, "lease.json"))).toBe(!acquisition);
  });

  it.each(["cleanup", "callback_and_cleanup"])("built_cli_prints_a_cleanup_failure_as_one_orch_line_and_exits_1: %s", (kind) => {
    const env = { ...process.env, ORCH_HOME: ctx.home };
    expect(spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "init", "--no-handbook"], { encoding: "utf8", env }).status).toBe(0);
    // A directory at the lease's temporary path makes the store inside the callback fail too.
    if (kind === "callback_and_cleanup") mkdirSync(join(ctx.home, "lease.json.tmp"));
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", faultScript("release_unlink", "EIO", false, true)], { encoding: "utf8", timeout: 5000, env });
    expect(r.status, r.stderr).toBe(1);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines, r.stderr).toHaveLength(1); // one line, no stack trace
    const fault = readFileSync(join(ctx.home, "fault-path"), "utf8");
    if (kind === "cleanup") expect(lines[0].startsWith(`orch: lock cleanup failed: unlink ${fault}: EIO; callback completed; effects may already be committed`)).toBe(true);
    else {
      expect(lines[0].startsWith("orch: EISDIR")).toBe(true);
      expect(lines[0]).toContain(`; lock cleanup failed: unlink ${fault}: EIO; callback failed; effects may already be committed`);
    }
    expect(existsSync(join(ctx.home, "lease.json"))).toBe(kind === "cleanup");
  });

  // The waiter's timeout has already passed when its failed mkdir is followed by a change at the
  // lock path. Each change is made inside a hook, so the order does not depend on timing.
  it.each([
    "released_then_free", "released_and_retaken_twice", "new_owner_not_yet_published", "released_then_new_owner_not_yet_published",
    "no_record_for_the_whole_wait", "owner_published_between_read_and_listing", "listing_fails",
  ])("the_timeout_edge_reports_only_what_the_waiter_saw: %s", (edge) => {
    const lock = join(ctx.home, "schedule.lock.d");
    const script = base() + `
      import { FileLock } from ${JSON.stringify(mod)};
      const edge = ${JSON.stringify(edge)}, timeoutMs = 40;
      function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
      const holder = new FileLock(lock);
      const mkdir = fs.mkdirSync, read = fs.readFileSync, list = fs.readdirSync;
      if (["no_record_for_the_whole_wait", "listing_fails"].includes(edge)) mkdir(lock);
      else if (edge !== "released_and_retaken_twice") holder.acquire();
      let first = 0, attempts = 0, changed = false;
      const expired = () => first > 0 && Date.now() - first > timeoutMs;
      fs.mkdirSync = function(path, ...args) {
        if (path !== lock || changed) return mkdir(path, ...args);
        attempts++;
        if (edge === "released_and_retaken_twice") {
          // Another process holds the lock at each attempt and has released it by each read.
          if (!first) { first = Date.now(); pause(timeoutMs + 20); }
          throw Object.assign(Error("held at this attempt"), { code: "EEXIST" });
        }
        if (edge === "released_then_new_owner_not_yet_published" && attempts === 2) {
          // The extra attempt loses to a successor whose owner record is not linked yet.
          changed = true; mkdir(lock);
          throw Object.assign(Error("held at this attempt"), { code: "EEXIST" });
        }
        try { return mkdir(path, ...args); }
        catch (e) {
          if (e.code !== "EEXIST") throw e;
          if (!first) first = Date.now();
          if (edge === "released_then_free" || edge === "released_then_new_owner_not_yet_published") {
            pause(timeoutMs + 20); holder.release(); changed = edge === "released_then_free";
          } else if (edge === "new_owner_not_yet_published" && expired()) {
            // The owner released and a successor's mkdir succeeded; its owner record is not linked yet.
            changed = true; holder.release(); mkdir(lock);
          }
          throw e;
        }
      };
      fs.readFileSync = function(path, ...args) {
        // The record is linked after this read and before the directory is listed.
        if (edge === "owner_published_between_read_and_listing" && path === lock + "/owner.json" && expired()) throw Object.assign(Error("not linked yet"), { code: "ENOENT" });
        return read(path, ...args);
      };
      fs.readdirSync = function(path, ...args) {
        if (edge === "listing_fails" && path === lock) throw Object.assign(Error("listing denied"), { code: "EACCES" });
        return list(path, ...args);
      };
      syncBuiltinESMExports();
      let callbacks = 0, error = null, message = null;
      try { withLock(lock, () => { callbacks++; }, { timeoutMs }); }
      catch (e) { error = e.name; message = e.message; }
      console.log(JSON.stringify({ callbacks, error, message, present: fs.existsSync(lock) }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(0);
    const r = JSON.parse(child.stdout);
    const reset = "stop every orch process and disable new launches, then remove the named lock directory " + lock;
    const refused = (name: string, present: boolean) => expect([r.callbacks, r.error, r.present], r.message).toEqual([0, name, present]);
    if (edge === "released_then_free") {
      // One more attempt: the lock was free, so the waiter takes it and nothing is reported.
      expect(r).toEqual({ callbacks: 1, error: null, message: null, present: false });
    } else if (edge === "released_and_retaken_twice") {
      refused("LockTimeoutError", false);
      expect(r.message).toContain("lock busy: " + lock);
      expect(r.message).toContain("in use, not abandoned; remove nothing and run the command again");
      expect(r.message).not.toContain("remove the named lock directory");
    } else if (edge.endsWith("new_owner_not_yet_published")) {
      refused("LockOwnerError", true);
      expect(r.message).toMatch(/\(no owner record for the last \d+ms of a \d+ms wait; a new owner may still be publishing it\)/);
      expect(r.message).toContain("; run the command again; if it reports this again, " + reset);
    } else if (edge === "no_record_for_the_whole_wait") {
      refused("LockOwnerError", true);
      expect(r.message).toMatch(/\(no owner record during the whole \d+ms wait\); stop every orch process/);
      expect(r.message).toContain(reset);
      expect(r.message).not.toContain("run the command again");
    } else if (edge === "owner_published_between_read_and_listing") {
      refused("LockTimeoutError", true);
      expect(r.message).toContain("no automatic recovery; " + reset);
    } else {
      refused("LockOwnerError", true);
      expect(r.message).toContain("(cannot inspect lock directory: EACCES); " + reset);
    }
  });

  it("callback_and_cleanup_errors_are_both_reported", () => {
    writeFileSync(join(ctx.home, "protected"), "old snapshot");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", faultScript("release_unlink", "EIO", true, false)], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(1);
    const r = JSON.parse(child.stdout);
    expect(r.callbacks).toBe(1);
    expect(r.error).toBe("AggregateError");
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toBe("callback boom");
    expect(r.errors[1]).toContain("lock cleanup failed: unlink");
    expect(r.message).toContain("callback boom");
    expect(r.message).toContain(readFileSync(join(ctx.home, "fault-path"), "utf8"));
    expect(r.message).toContain("EIO; callback failed; effects may already be committed");
    expect(r.message).toContain("owner record remains");
    expect(readFileSync(join(ctx.home, "protected"), "utf8")).toBe("committed effect");
  });

  it("cleanup_inspection_failure_reports_state_unknown", () => {
    writeFileSync(join(ctx.home, "protected"), "old snapshot");
    const script = base() + `
      const unlink = fs.unlinkSync, list = fs.readdirSync;
      fs.unlinkSync = function(path, ...args) { if (String(path).startsWith(lock + "/.owner-")) throw Object.assign(Error("unlink EIO"), { code: "EIO" }); return unlink(path, ...args); };
      fs.readdirSync = function(path, ...args) { if (path === lock) throw Object.assign(Error("inspection EACCES"), { code: "EACCES" }); return list(path, ...args); };
      syncBuiltinESMExports();
      let callbacks = 0;
      try { withLock(lock, () => { callbacks++; atomicWrite(dest, "wrongful effect"); }); }
      catch (e) { console.log(JSON.stringify({ callbacks, operation: e.operation, path: e.path, errno: e.errno, stage: e.stage, state: e.state, message: e.message })); process.exitCode = 1; }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(1);
    const r = JSON.parse(child.stdout), lock = join(ctx.home, "schedule.lock.d");
    expect(r.callbacks).toBe(0);
    expect(r.operation).toBe("unlink");
    expect(r.path).toMatch(new RegExp("/schedule\\.lock\\.d/\\.owner-"));
    expect(r.errno).toBe("EIO");
    expect(r.stage).toBe("callback not entered; owner published");
    expect(r.state).toBe(lock + ": state unknown (EACCES)");
    expect(r.message).toContain(r.state);
    expect(existsSync(lock + "/owner.json")).toBe(true);
    expect(readFileSync(join(ctx.home, "protected"), "utf8")).toBe("old snapshot");
  });

  it.each(["write", "link"])("failed_initialization_releases_only_its_own_directory_without_entering_callback: %s", (cut) => {
    writeFileSync(join(ctx.home, "protected"), "old snapshot");
    const script = base() + `
      const write = fs.writeFileSync, link = fs.linkSync;
      fs.writeFileSync = function(path, ...args) { if (${JSON.stringify(cut)} === "write" && String(path).startsWith(lock + "/.owner-")) throw Object.assign(Error("initialization ENOSPC"), { code: "ENOSPC" }); return write(path, ...args); };
      fs.linkSync = function(from, to) { if (${JSON.stringify(cut)} === "link" && to === lock + "/owner.json") throw Object.assign(Error("initialization ENOSPC"), { code: "ENOSPC" }); return link(from, to); };
      syncBuiltinESMExports();
      let callbacks = 0;
      try { withLock(lock, () => { callbacks++; atomicWrite(dest, "wrongful effect"); }); }
      catch (e) { console.log(JSON.stringify({ callbacks, message: e.message })); process.exitCode = 1; }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(1);
    expect(JSON.parse(child.stdout)).toEqual({ callbacks: 0, message: "initialization ENOSPC" });
    expect(existsSync(join(ctx.home, "schedule.lock.d"))).toBe(false);
    expect(readFileSync(join(ctx.home, "protected"), "utf8")).toBe("old snapshot");
    const next = spawnSync(process.execPath, ["--input-type=module", "-e", base() + `withLock(lock, () => atomicWrite(dest, "next effect"));`], { encoding: "utf8", timeout: 5000 });
    expect(next.status, next.stderr).toBe(0);
    expect(readFileSync(join(ctx.home, "protected"), "utf8")).toBe("next effect");
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
