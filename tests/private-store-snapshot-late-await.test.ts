import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindWorkspace, partitionPaths } from "../src/private-store/binding.js";
import { PrivateStoreError } from "../src/private-store/errors.js";
import { commitSnapshot, readSnapshot, recoverSnapshot, type SnapshotSeam } from "../src/private-store/snapshot.js";

const homes: string[] = [];
const tempName = ".state-00000000-0000-4000-8000-000000000001.tmp";
const codec = {
  decode(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "text"
      || typeof (value as { text: unknown }).text !== "string") throw Error("bad payload");
    return value as { text: string };
  },
  encode(value: { text: string }) { return value; },
};
const eio = () => Object.assign(new Error("injected I/O fault"), { code: "EIO" });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Api = "read" | "commit" | "recover";
type Target = "opendir" | "dir-read" | "dir-close" | "inventory-lstat" | "lock-eexist"
  | "lock-mkdir" | "lock-lstat" | "remove-lstat" | "rmdir-fail" | "rmdir-ok"
  | "unlink-fail" | "unlink-ok" | "temp-open" | "temp-stat" | "temp-write"
  | "temp-sync" | "temp-close" | "fallback-close";
type Probe = { site: string; name: string; api: Api; target: Target; primary?: "opendir" | "dir-read" | "write";
  held?: boolean; temp?: boolean; lateCode: string; controlCode: string };

// One entry per memo operation variant. The three EEXIST entries copy the reviewer's K2.05 public-API paths.
const probes: Probe[] = [
  { site: "snapshot.ts:148", name: "names_opendir_EIO", api: "read", target: "opendir", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:154", name: "names_read_EIO", api: "read", target: "dir-read", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:164", name: "names_close_EIO", api: "read", target: "dir-close", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:164", name: "names_close_after_read_EIO", api: "read", target: "dir-close", primary: "dir-read", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:179", name: "inventory_lstat_EIO", api: "read", target: "inventory-lstat", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:204", name: "own_late_EEXIST_overall_deadline_read", api: "read", target: "lock-eexist", held: true, lateCode: "DEADLINE", controlCode: "LOCK_HELD" },
  { site: "snapshot.ts:204", name: "own_late_EEXIST_overall_deadline_commit", api: "commit", target: "lock-eexist", held: true, lateCode: "DEADLINE", controlCode: "LOCK_HELD" },
  { site: "snapshot.ts:204", name: "own_late_EEXIST_overall_deadline_recover", api: "recover", target: "lock-eexist", held: true, lateCode: "DEADLINE", controlCode: "LOCK_HELD" },
  { site: "snapshot.ts:218", name: "lock_mkdir_EIO", api: "read", target: "lock-mkdir", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:207", name: "owned_lock_lstat_EIO", api: "read", target: "lock-lstat", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:230", name: "remove_identity_lstat_EIO", api: "read", target: "remove-lstat", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:233", name: "remove_owned_rmdir_EIO", api: "read", target: "rmdir-fail", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:233", name: "remove_owned_unlink_EIO", api: "recover", target: "unlink-fail", temp: true, lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:253", name: "withLock_primary_then_late_rmdir", api: "read", target: "rmdir-ok", primary: "opendir", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:284", name: "read_release_late_rmdir_EIO", api: "read", target: "rmdir-fail", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:337", name: "exclusive_temp_open_EIO", api: "commit", target: "temp-open", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:339", name: "temp_handle_stat_EIO", api: "commit", target: "temp-stat", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:346", name: "temp_write_EIO", api: "commit", target: "temp-write", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:356", name: "temp_sync_EIO", api: "commit", target: "temp-sync", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:358", name: "temp_close_EIO", api: "commit", target: "temp-close", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:362", name: "fallback_close_after_write_EIO", api: "commit", target: "fallback-close", primary: "write", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:363", name: "fallback_unlink_after_write_EIO", api: "commit", target: "unlink-ok", primary: "write", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
  { site: "snapshot.ts:421", name: "recovery_temp_late_unlink", api: "recover", target: "unlink-ok", temp: true, lateCode: "DEADLINE", controlCode: "RECOVERED" },
  { site: "snapshot.ts:423", name: "recovery_lock_late_rmdir", api: "recover", target: "rmdir-ok", lateCode: "DEADLINE", controlCode: "RECOVERED" },
  { site: "snapshot.ts:425", name: "recovery_lock_late_rmdir_EIO", api: "recover", target: "rmdir-fail", lateCode: "DEADLINE", controlCode: "IO_UNAVAILABLE" },
];

async function fixture(probe: Probe) {
  const workspace = mkdtempSync(join(tmpdir(), "oo232-late-await-"));
  homes.push(workspace);
  const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
  const paths = partitionPaths(binding);
  await commitSnapshot(binding, codec, 0, { text: "old" }, performance.now() + 5_000);
  if (probe.held) mkdirSync(paths.lock, { mode: 0o700 });
  if (probe.temp) writeFileSync(join(paths.directory, tempName), "staged", { mode: 0o600 });
  const before = readFileSync(paths.state);
  const state = lstatSync(paths.state);
  const initialLock = existsSync(paths.lock) ? lstatSync(paths.lock) : undefined;
  const initialTemp = probe.temp ? lstatSync(join(paths.directory, tempName)) : undefined;
  return { binding, paths, before, state, initialLock, initialTemp };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function run(probe: Probe, late: boolean) {
  const f = await fixture(probe);
  let shift = 0;
  let hit = 0;
  let lockStats = 0;
  let lockCreated = false;
  let tempCreatedPath: string | undefined;
  let targetSubmittedAt: number | undefined;
  let targetCompletedAt: number | undefined;
  const deadline = performance.now() + (late ? 200 : 4_000);
  const now = () => performance.now() + shift;
  const started: { op: string; path: string; at: number }[] = [];
  const completed: { op: string; at: number }[] = [];
  const start = (op: string, path: unknown) => { started.push({ op, path: String(path), at: now() }); };
  const finish = (op: string) => { completed.push({ op, at: now() }); };
  const target = async (op: string, effect: () => Promise<void>, reject = true) => {
    hit++;
    targetSubmittedAt = now();
    await effect();
    if (late) await sleep(350);
    else if (probe.target === "lock-eexist") shift = 2_100;
    targetCompletedAt = now();
    finish(op);
    if (reject) throw eio();
  };
  const decorate = (handle: FileHandle, path: string) => {
    const rawStat = handle.stat.bind(handle);
    const rawClose = handle.close.bind(handle);
    handle.stat = (async () => {
      start("stat", path);
      if (path.endsWith(".tmp") && probe.target === "temp-stat") {
        await target("stat", async () => { await rawStat(); });
        throw Error("unreachable");
      }
      const value = await rawStat(); finish("stat"); return value;
    }) as typeof handle.stat;
    handle.close = async () => {
      start("close", path);
      if (path.endsWith(".tmp") && probe.target === "fallback-close") {
        await target("close", rawClose, false); return;
      }
      await rawClose(); finish("close");
    };
    return handle;
  };
  const seam: SnapshotSeam = {
    clock: now,
    mkdir: async (path, options) => {
      start("mkdir", path);
      if (path === f.paths.lock && probe.target === "lock-mkdir") {
        await target("mkdir", async () => {}); return;
      }
      try { await mkdir(path, options); if (path === f.paths.lock) lockCreated = true; finish("mkdir"); }
      catch (error) {
        if (path === f.paths.lock && probe.target === "lock-eexist") {
          hit++;
          targetSubmittedAt = now();
          if (late) await sleep(350); else shift = 2_100;
          targetCompletedAt = now();
          finish("mkdir");
        }
        throw error;
      }
    },
    lstat: (async (path) => {
      start("lstat", path);
      if (path === f.paths.lock) lockStats++;
      const selected = path === f.paths.state && probe.target === "inventory-lstat"
        || path === f.paths.lock && probe.target === "lock-lstat" && lockStats === 1
        || path === f.paths.lock && probe.target === "remove-lstat" && lockStats === 3;
      if (selected) {
        await target("lstat", async () => { await lstat(path); });
        throw Error("unreachable");
      }
      const value = await lstat(path); finish("lstat"); return value;
    }) as typeof lstat,
    open: async (path, flags, mode) => {
      const name = String(path);
      start("open", `${name}|flags=${String(flags)}`);
      if (name.endsWith(".tmp") && probe.target === "temp-open") {
        await target("open", async () => {});
        throw Error("unreachable");
      }
      const handle = decorate(await open(path, flags, mode), name);
      if (name.endsWith(".tmp")) tempCreatedPath = name;
      finish("open"); return handle;
    },
    opendir: async (path) => {
      const name = String(path);
      start("opendir", path);
      if (path === f.paths.directory && (probe.target === "opendir" || probe.primary === "opendir")) {
        if (probe.primary === "opendir") { hit++; finish("opendir"); throw eio(); }
        await target("opendir", async () => { const dir = await opendir(path); await dir.close(); });
        throw Error("unreachable");
      }
      const dir = await opendir(path); finish("opendir");
      const rawRead = dir.read.bind(dir);
      const rawClose = dir.close.bind(dir);
      dir.read = async () => {
        start("dir.read", name);
        if (path === f.paths.directory && probe.primary === "dir-read") { hit++; finish("dir.read"); throw eio(); }
        if (path === f.paths.directory && probe.target === "dir-read") {
          await target("dir.read", async () => { await rawRead(); });
          throw Error("unreachable");
        }
        const item = await rawRead(); finish("dir.read"); return item;
      };
      dir.close = async () => {
        start("dir.close", name);
        if (path === f.paths.directory && probe.target === "dir-close") {
          await target("dir.close", rawClose);
          return;
        }
        await rawClose(); finish("dir.close");
      };
      return dir;
    },
    write: async (handle, bytes, offset) => {
      start("write", "temp");
      if (probe.primary === "write") { hit++; finish("write"); throw eio(); }
      if (probe.target === "temp-write") {
        await target("write", async () => { await handle.write(bytes, offset, bytes.length - offset, offset); });
        throw Error("unreachable");
      }
      const value = await handle.write(bytes, offset, bytes.length - offset, offset); finish("write"); return value;
    },
    read: async (handle, buffer) => {
      start("read", f.paths.state);
      const value = await handle.read(buffer, 0, buffer.length, null); finish("read"); return value;
    },
    sync: async (handle) => {
      start("sync", "temp");
      if (probe.target === "temp-sync") {
        await target("sync", async () => { await handle.sync(); }); return;
      }
      await handle.sync(); finish("sync");
    },
    close: async (handle) => {
      start("seam.close", "temp");
      if (probe.target === "temp-close") {
        await target("seam.close", async () => { await handle.close(); }); return;
      }
      await handle.close(); finish("seam.close");
    },
    rmdir: async (path) => {
      start("rmdir", path);
      if (path === f.paths.lock && probe.target.startsWith("rmdir-")) {
        await target("rmdir", async () => { if (probe.target === "rmdir-ok") await rmdir(path); }, probe.target === "rmdir-fail");
        return;
      }
      await rmdir(path); finish("rmdir");
    },
    unlink: async (path) => {
      start("unlink", path);
      if (String(path).endsWith(".tmp") && probe.target.startsWith("unlink-")) {
        await target("unlink", async () => { if (probe.target === "unlink-ok") await unlink(path); }, probe.target === "unlink-fail");
        return;
      }
      await unlink(path); finish("unlink");
    },
    rename: async (source, destination) => {
      start("rename", `${source}->${destination}`);
      await rename(source, destination); finish("rename");
    },
  };
  const action = probe.api === "read" ? readSnapshot(f.binding, codec, deadline, (value) => value, seam)
    : probe.api === "commit" ? commitSnapshot(f.binding, codec, 1, { text: "new" }, deadline, seam)
    : recoverSnapshot(f.binding, codec, deadline, seam);
  const actual = await action.then((value) => value, (error: unknown) => error);
  const code = actual instanceof PrivateStoreError ? actual.code
    : typeof actual === "object" && actual && "status" in actual ? String(actual.status).toUpperCase() : "RAW_ERROR";
  const entries = readdirSync(f.paths.directory).sort();
  const lock = existsSync(f.paths.lock) ? lstatSync(f.paths.lock) : undefined;
  const tempPath = join(f.paths.directory, tempName);
  const temp = existsSync(tempPath) ? lstatSync(tempPath) : undefined;
  const temps = entries.filter((entry) => entry.endsWith(".tmp")).map((entry) => {
    const path = join(f.paths.directory, entry);
    const info = lstatSync(path);
    return { name: entry, dev: info.dev, ino: info.ino,
      owner: path === tempCreatedPath ? "operation" : path === tempPath && !!f.initialTemp ? "fixture" : "unknown" };
  });
  const after = lstatSync(f.paths.state);
  const afterExpiry = started.filter((event) => event.at >= deadline && event.op !== "close" && event.op !== "dir.close");
  const record = {
    site: probe.site, name: probe.name, phase: late ? "late" : "control", expected: late ? probe.lateCode : probe.controlCode,
    observed: code, hit, submitted: started.length, completed: completed.length,
    targetSubmittedAt, targetCompletedAt, deadline, settledLate: targetCompletedAt === undefined ? null : targetCompletedAt >= deadline,
    canonicalSame: readFileSync(f.paths.state).equals(f.before) && after.dev === f.state.dev && after.ino === f.state.ino,
    lock: lock ? { dev: lock.dev, ino: lock.ino,
      owner: f.initialLock && lock.dev === f.initialLock.dev && lock.ino === f.initialLock.ino ? "fixture"
        : lockCreated ? "operation" : "unknown" } : null,
    temp: temp ? { dev: temp.dev, ino: temp.ino, ownedBefore: !!f.initialTemp && temp.dev === f.initialTemp.dev && temp.ino === f.initialTemp.ino } : null,
    temps, entries, postExpiryIO: afterExpiry.map(({ op, path }) => `${op}:${path}`),
    lockReleased: actual instanceof PrivateStoreError ? (actual as PrivateStoreError & { lockReleased?: boolean }).lockReleased
      : typeof actual === "object" && actual && "lockReleased" in actual ? actual.lockReleased : undefined,
  };
  console.log(`AUDIT_CASE ${JSON.stringify(record)}`);
  expect(hit).toBeGreaterThan(0);
  expect(record.settledLate).toBe(late);
  expect(actual instanceof PrivateStoreError || code === "RECOVERED" || code === "READ").toBe(true);
  expect(record.canonicalSame).toBe(true);
  expect(record.postExpiryIO).toEqual([]);
  if (f.initialLock) expect(lock && lock.dev === f.initialLock.dev && lock.ino === f.initialLock.ino).toBe(true);
  if (f.initialTemp && temp) expect(temp.dev === f.initialTemp.dev && temp.ino === f.initialTemp.ino).toBe(true);
  expect(started.filter((event) => event.op === "rmdir").every((event) => event.path === f.paths.lock && lockCreated)).toBe(true);
  expect(started.filter((event) => event.op === "unlink").every((event) =>
    event.path === tempCreatedPath || event.path === tempPath && !!f.initialTemp && probe.api === "recover")).toBe(true);
  expect(code).toBe(record.expected);
}

for (const probe of probes) {
  it(`${probe.name} control`, async () => { await run(probe, false); });
  it(`${probe.name} late`, async () => { await run(probe, true); });
}
