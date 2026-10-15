// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { partitionPaths, type Binding } from "./binding.js";
import { errno, normalize, PrivateStoreError, type ErrorCode } from "./errors.js";
import { decodeStrictJson, StrictJsonError } from "./json.js";
import { MAX_BUDGET_MS, type TestSeam } from "./limits.js";
import { inspectPartition, openPrivateFile, preparePartition, readBounded } from "./privacy.js";

const STATE_CAP = 16 * 1024 * 1024;
const QUOTA = 32 * 1024 * 1024;
const OUTPUT_CAP = 64 * 1024;
const TEMP = /^\.state-[0-9a-f-]{36}\.tmp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFINITE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EXDEV", "EINVAL", "EISDIR", "ENOTEMPTY", "EBUSY", "EROFS"]);
const AMBIGUOUS = new Set(["EIO", "ENOSPC"]);
type Warning = "DIRECTORY_NOT_FLUSHED" | "INVENTORY_UNVERIFIED" | "LOCK_LEFT";
type Identity = { dev: number; ino: number };
type Inventory = { state?: Stats; lock?: Stats; temps: { name: string; info: Stats }[] };
type Envelope<T> = { generation: number; committedAt: string; payload: T };

export interface SnapshotCodec<T> { decode(value: unknown): T; encode(value: T): unknown; }
export interface SnapshotContext { readonly generation: number; readonly committedAt: string | null; }
export interface SnapshotSeam extends TestSeam {
  write?: (handle: FileHandle, bytes: Buffer, offset: number) => Promise<{ bytesWritten: number }>;
  sync?: (handle: FileHandle) => Promise<void>;
  close?: (handle: FileHandle) => Promise<void>;
  rename?: typeof rename;
  rmdir?: typeof rmdir;
  unlink?: typeof unlink;
  opendir?: typeof opendir;
}
export type ReadResult = { status: "absent"; generation: 0 } | { status: "read"; generation: number; output: Buffer };
export type WrittenResult = { status: "written"; generation: number; durability: "synced" | "unverified";
  inventoryVerified: boolean; lockReleased: boolean; warnings: Warning[] };
export type UncertainResult = { status: "uncertain"; code: "WRITE_OUTCOME_UNKNOWN"; lockReleased: false; warnings: ["LOCK_LEFT"] };
export type RecoveryResult = { status: "recovered"; generation: number; discardedTemps: number;
  lockReleased: boolean; warnings: Warning[] };

function fail(code: ErrorCode, lockReleased = true, retainLock = false): never {
  const error = new PrivateStoreError(code) as PrivateStoreError & { lockReleased: boolean; warnings: Warning[]; retainLock: boolean };
  error.lockReleased = lockReleased;
  error.warnings = lockReleased ? [] : ["LOCK_LEFT"];
  error.retainLock = retainLock;
  throw error;
}
function same(info: Stats, id: Identity): boolean { return info.dev === id.dev && info.ino === id.ino; }
function safe(info: Stats, folder: boolean, seam: SnapshotSeam): boolean {
  return info.uid === (seam.uid?.() ?? process.getuid!()) && (info.mode & 0o7777) === (folder ? 0o700 : 0o600)
    && (folder ? info.isDirectory() : info.isFile() && info.nlink === 1);
}
function compare(a: string, b: string): number {
  const left = Array.from(a, (part) => part.codePointAt(0)!);
  const right = Array.from(b, (part) => part.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function canonical(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!(value as string & { isWellFormed(): boolean }).isWellFormed() || Buffer.byteLength(value) > 256 * 1024) fail("BAD_INPUT");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("BAD_INPUT");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || depth >= 8 || seen.has(value)) fail("BAD_INPUT");
  seen.add(value);
  let encoded: string;
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail("TOO_LARGE");
    encoded = `[${value.map((item) => canonical(item, depth + 1, seen)).join(",")}]`;
  } else {
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail("BAD_INPUT");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(compare);
    if (keys.length > 32 || Object.getOwnPropertySymbols(value).length) fail("TOO_LARGE");
    encoded = `{${keys.map((key) => {
      const entry = descriptors[key];
      if (!entry.enumerable || !Object.hasOwn(entry, "value") || ["__proto__", "prototype", "constructor"].includes(key)
        || Buffer.byteLength(key) > 256 * 1024) fail("BAD_INPUT");
      return `${JSON.stringify(key)}:${canonical(entry.value, depth + 1, seen)}`;
    }).join(",")}}`;
  }
  seen.delete(value);
  return encoded;
}
function valueForDisk<T>(codec: SnapshotCodec<T>, value: T): unknown {
  try {
    const bytes = Buffer.from(canonical(codec.encode(value)));
    const parsed = decodeStrictJson(bytes, { maxInputBytes: STATE_CAP });
    codec.decode(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof PrivateStoreError && error.code === "TOO_LARGE"
      || error instanceof StrictJsonError && error.code === "TOO_LARGE") fail("TOO_LARGE");
    fail("BAD_INPUT");
  }
}
function decoded<T>(bytes: Buffer, binding: Binding, codec: SnapshotCodec<T>): Envelope<T> {
  let raw: unknown;
  try { raw = decodeStrictJson(bytes, { maxInputBytes: STATE_CAP }); }
  catch (error) { fail(error instanceof StrictJsonError && error.code === "TOO_LARGE" ? "TOO_LARGE" : "CORRUPT_STATE"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("CORRUPT_STATE");
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "committedAt,format,generation,namespace,payload,workspaceDigest") fail("CORRUPT_STATE");
  const directory = partitionPaths(binding).directory;
  const stamp = record.committedAt;
  if (record.format !== 1 || record.namespace !== basename(dirname(dirname(directory))) || record.workspaceDigest !== basename(directory)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || typeof stamp !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(stamp) || Number.isNaN(Date.parse(stamp))
    || new Date(stamp).toISOString() !== stamp) fail("CORRUPT_STATE");
  try { return { generation: record.generation as number, committedAt: stamp, payload: codec.decode(record.payload) }; }
  catch { fail("CORRUPT_STATE"); }
}
class Clock {
  readonly started: number;
  constructor(readonly deadline: number, readonly seam: SnapshotSeam) {
    const keys = new Set(["platform", "uid", "clock", "uuid", "lstat", "realpath", "statfs", "mkdir", "open", "flags",
      "read", "write", "sync", "close", "rename", "rmdir", "unlink", "opendir"]);
    if (!seam || typeof seam !== "object" || Array.isArray(seam)
      || Object.entries(seam).some(([key, entry]) => !keys.has(key) || typeof entry !== "function")) fail("BAD_INPUT");
    if (process.platform === "win32" || seam.platform?.() === "win32") fail("PRIVACY_UNAVAILABLE");
    this.started = this.now();
    if (!Number.isFinite(deadline) || deadline > this.started + MAX_BUDGET_MS) fail("BAD_INPUT");
    this.check();
  }
  now(): number { return (this.seam.clock ?? performance.now.bind(performance))(); }
  check(): void { if (this.now() >= this.deadline) fail("DEADLINE"); }
  base(): TestSeam {
    const { write, sync, close, rename: replace, rmdir: removeLock, unlink: removeTemp, opendir: list, ...base } = this.seam;
    void write; void sync; void close; void replace; void removeLock; void removeTemp; void list;
    return base;
  }
  async call<T>(action: () => Promise<T>): Promise<T> { this.check(); const result = await action(); this.check(); return result; }
}
async function opened(path: string, flags: number, clock: Clock, mode?: number): Promise<FileHandle> {
  clock.check();
  const handle = await (clock.seam.open ?? open)(path, clock.seam.flags?.(flags) ?? flags, mode);
  try { clock.check(); return handle; }
  catch (error) { await handle.close().catch(() => undefined); throw error; }
}
async function names(path: string, clock: Clock): Promise<string[]> {
  clock.check();
  const dir = await (clock.seam.opendir ?? opendir)(path);
  const result: string[] = [];
  let failed = false;
  try {
    clock.check();
    for (;;) {
      const entry = await clock.call(() => dir.read());
      if (!entry) break;
      result.push(entry.name);
      if (result.length > 32) fail("TOO_LARGE");
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await dir.close();
    } catch (error) {
      if (!failed) {
        throw error;
      }
    }
  }
  clock.check();
  return result;
}
async function inventory(path: string, clock: Clock): Promise<Inventory> {
  const result: Inventory = { temps: [] };
  let total = 0;
  for (const name of await names(path, clock)) {
    if (name !== ".lock" && name !== "state.json" && !TEMP.test(name)) fail("UNSAFE_PATH");
    const info = await clock.call(() => (clock.seam.lstat ?? lstat)(join(path, name)));
    if (!safe(info, name === ".lock", clock.seam)) fail("UNSAFE_PATH");
    if (name !== ".lock") total += info.size;
    if (!Number.isSafeInteger(total) || total > QUOTA) fail("TOO_LARGE");
    if (name === "state.json") result.state = info;
    if (name === ".lock") result.lock = info;
    if (TEMP.test(name)) result.temps.push({ name, info });
  }
  return result;
}
async function current<T>(binding: Binding, codec: SnapshotCodec<T>, info: Stats | undefined, clock: Clock): Promise<Envelope<T> | undefined> {
  if (!info) return undefined;
  if (info.size > STATE_CAP) fail("TOO_LARGE");
  const opened = await openPrivateFile(binding, "state.json", clock.deadline, clock.base());
  if (opened.kind === "absent") fail("IO_UNAVAILABLE");
  const bytes = await readBounded(opened.handle, STATE_CAP, clock.deadline, clock.base());
  clock.check();
  return decoded(bytes, binding, codec);
}
async function acquire(path: string, clock: Clock): Promise<Identity> {
  const until = Math.min(clock.started + 2_000, clock.deadline);
  for (;;) {
    clock.check();
    let created = false;
    try {
      await (clock.seam.mkdir ?? mkdir)(path, { mode: 0o700 });
      created = true;
      if (clock.now() >= clock.deadline) fail("DEADLINE", false);
      const info = await (clock.seam.lstat ?? lstat)(path);
      if (clock.now() >= clock.deadline) fail("DEADLINE", false);
      if (!safe(info, true, clock.seam)) fail("UNSAFE_PATH", false);
      return { dev: info.dev, ino: info.ino };
    } catch (error) {
      if (error instanceof PrivateStoreError) {
        throw error;
      }
      if (created) {
        fail(normalize(error).code, false, true);
      }
      if (errno(error) !== "EEXIST") {
        fail(normalize(error).code);
      }
      if (clock.now() >= until) fail("LOCK_HELD");
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, until - clock.now())));
      clock.check();
    }
  }
}
async function remove(path: string, id: Identity, folder: boolean, clock: Clock): Promise<boolean> {
  if (clock.now() >= clock.deadline) return false;
  try {
    const info = await (clock.seam.lstat ?? lstat)(path);
    if (clock.now() >= clock.deadline || !same(info, id) || !safe(info, folder, clock.seam)) return false;
    clock.check();
    await (folder ? (clock.seam.rmdir ?? rmdir)(path) : (clock.seam.unlink ?? unlink)(path));
    return true;
  } catch { return false; }
}
function uncertain(): UncertainResult {
  return { status: "uncertain", code: "WRITE_OUTCOME_UNKNOWN", lockReleased: false, warnings: ["LOCK_LEFT"] };
}
function warnings(durability: "synced" | "unverified", inventoryVerified: boolean, lockReleased: boolean): Warning[] {
  const result: Warning[] = [];
  if (durability === "unverified") result.push("DIRECTORY_NOT_FLUSHED");
  if (!inventoryVerified) result.push("INVENTORY_UNVERIFIED");
  if (!lockReleased) result.push("LOCK_LEFT");
  return result;
}
async function withLock<T>(binding: Binding, clock: Clock, action: (id: Identity) => Promise<T>): Promise<T> {
  const path = partitionPaths(binding).lock;
  const id = await acquire(path, clock);
  try { return await action(id); }
  catch (error) {
    if (error instanceof PrivateStoreError && (error as PrivateStoreError & { retainLock?: boolean }).retainLock) throw error;
    const released = await remove(path, id, true, clock);
    const code = normalize(error).code;
    fail(code, released);
  }
}
export async function readSnapshot<T, O = SnapshotContext>(
  binding: Binding, codec: SnapshotCodec<T>, deadline: number,
  projector: (value: T, context: SnapshotContext) => O = ((_, context) => context as O),
  seam: SnapshotSeam = {},
): Promise<ReadResult> {
  const clock = new Clock(deadline, seam);
  partitionPaths(binding);
  if (typeof codec?.decode !== "function" || typeof codec.encode !== "function" || typeof projector !== "function") fail("BAD_INPUT");
  if ((await inspectPartition(binding, deadline, clock.base())).kind === "absent") return { status: "absent", generation: 0 };
  return withLock(binding, clock, async (id) => {
    const paths = partitionPaths(binding);
    const found = await inventory(paths.directory, clock);
    if (found.temps.length) fail("RECOVERY_REQUIRED", false);
    const snapshot = await current(binding, codec, found.state, clock);
    let result: ReadResult = { status: "absent", generation: 0 };
    if (snapshot) {
      const context = Object.freeze({ generation: snapshot.generation, committedAt: snapshot.committedAt });
      let projected: unknown;
      try { projected = projector(snapshot.payload, context); }
      catch { fail("BAD_INPUT", false); }
      clock.check();
      const output = Buffer.from(canonical(projected) + "\n");
      if (output.length > OUTPUT_CAP) fail("TOO_LARGE", false);
      result = { status: "read", generation: snapshot.generation, output };
    }
    clock.check();
    if (!await remove(paths.lock, id, true, clock)) fail("IO_UNAVAILABLE", false, true);
    if (clock.now() >= deadline) fail("DEADLINE", true, true);
    return result;
  });
}
export async function commitSnapshot<T>(
  binding: Binding, codec: SnapshotCodec<T>, expectedGeneration: number, value: T,
  deadline: number, seam: SnapshotSeam = {},
): Promise<WrittenResult | UncertainResult> {
  const clock = new Clock(deadline, seam);
  partitionPaths(binding);
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0
    || typeof codec?.decode !== "function" || typeof codec.encode !== "function") fail("BAD_INPUT");
  valueForDisk(codec, value);
  clock.check();
  return mutateSnapshot(binding, codec, expectedGeneration, deadline, () => value, seam);
}
export async function mutateSnapshot<T>(
  binding: Binding, codec: SnapshotCodec<T>, expectedGeneration: number, deadline: number,
  reducer: (current: T | undefined, context: SnapshotContext) => T, seam: SnapshotSeam = {},
): Promise<WrittenResult | UncertainResult> {
  const clock = new Clock(deadline, seam);
  partitionPaths(binding);
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || typeof reducer !== "function"
    || typeof codec?.decode !== "function" || typeof codec.encode !== "function") fail("BAD_INPUT");
  await preparePartition(binding, deadline, clock.base());
  return withLock(binding, clock, async (id) => {
    const paths = partitionPaths(binding);
    const found = await inventory(paths.directory, clock);
    if (found.temps.length) fail("RECOVERY_REQUIRED", false);
    const previous = await current(binding, codec, found.state, clock);
    const generation = previous?.generation ?? 0;
    if (generation !== expectedGeneration) fail("CONFLICT", false);
    if (generation === Number.MAX_SAFE_INTEGER) fail("BAD_INPUT", false);
    const context = Object.freeze({ generation, committedAt: previous?.committedAt ?? null });
    let next: T;
    try { next = reducer(previous?.payload, context); }
    catch { fail("BAD_INPUT", false); }
    clock.check();
    const payload = valueForDisk(codec, next);
    const directory = paths.directory;
    const envelope = { format: 1, namespace: basename(dirname(dirname(directory))), workspaceDigest: basename(directory),
      generation: generation + 1, committedAt: new Date().toISOString(), payload };
    const bytes = Buffer.from(canonical(envelope) + "\n");
    if (bytes.length > STATE_CAP || (found.state?.size ?? 0) + bytes.length > QUOTA) fail("TOO_LARGE", false);
    const uuid = (seam.uuid ?? randomUUID)();
    if (!UUID.test(uuid)) fail("BAD_INPUT", false);
    const temp = join(directory, `.state-${uuid}.tmp`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    let handle: FileHandle | undefined;
    let tempId: Identity | undefined;
    try {
      clock.check();
      handle = await (seam.open ?? open)(temp, seam.flags?.(flags) ?? flags, 0o600);
      if (clock.now() >= deadline) fail("DEADLINE", false);
      const info = await clock.call(() => handle!.stat());
      if (!safe(info, false, seam)) fail("UNSAFE_PATH", false);
      tempId = { dev: info.dev, ino: info.ino };
      let offset = 0;
      while (offset < bytes.length) {
        let count: number;
        try {
          const result = await clock.call(() => seam.write
            ? seam.write(handle!, bytes, offset) : handle!.write(bytes, offset, bytes.length - offset, offset));
          count = result.bytesWritten;
        } catch (error) {
          if (errno(error) === "EINTR") continue;
          throw error;
        }
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("IO_UNAVAILABLE", false);
        offset += count;
      }
      await clock.call(() => seam.sync ? seam.sync(handle!) : handle!.sync());
      clock.check();
      await (seam.close ?? ((file) => file.close()))(handle);
      handle = undefined;
      clock.check();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (tempId) await remove(temp, tempId, false, clock);
      throw error;
    }
    try {
      clock.check();
      await (seam.rename ?? rename)(temp, paths.state);
    } catch (error) {
      const code = errno(error);
      if (!DEFINITE.has(code ?? "") && !AMBIGUOUS.has(code ?? "")) throw error;
      if (clock.now() >= deadline) return uncertain();
      let installed: boolean;
      try { installed = same(await (seam.lstat ?? lstat)(paths.state), tempId); }
      catch { return uncertain(); }
      if (!installed) {
        if (AMBIGUOUS.has(code ?? "")) return uncertain();
        if (clock.now() < deadline) await remove(temp, tempId, false, clock);
        fail("IO_UNAVAILABLE", false);
      }
    }
    let durability: "synced" | "unverified" = "unverified";
    let inventoryVerified = false;
    if (clock.now() < deadline) {
      let folder: FileHandle | undefined;
      try {
        folder = await opened(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY, clock);
        await clock.call(() => seam.sync ? seam.sync(folder!) : folder!.sync());
        await (seam.close ?? ((file) => file.close()))(folder);
        folder = undefined;
        clock.check();
        durability = "synced";
      } catch { if (folder) await folder.close().catch(() => undefined); }
    }
    if (clock.now() < deadline) {
      try {
        const final = await inventory(directory, clock);
        inventoryVerified = !!final.state && same(final.state, tempId) && final.temps.length === 0
          && !!final.lock && same(final.lock, id) && (await names(paths.lock, clock)).length === 0;
      } catch { inventoryVerified = false; }
    }
    const lockReleased = await remove(paths.lock, id, true, clock);
    return { status: "written", generation: generation + 1, durability, inventoryVerified, lockReleased,
      warnings: warnings(durability, inventoryVerified, lockReleased) };
  });
}
export async function recoverSnapshot<T>(
  binding: Binding, codec: SnapshotCodec<T>, deadline: number, seam: SnapshotSeam = {},
): Promise<RecoveryResult> {
  const clock = new Clock(deadline, seam);
  partitionPaths(binding);
  if (typeof codec?.decode !== "function" || typeof codec.encode !== "function") fail("BAD_INPUT");
  if ((await inspectPartition(binding, deadline, clock.base())).kind === "absent") {
    return { status: "recovered", generation: 0, discardedTemps: 0, lockReleased: true, warnings: [] };
  }
  return withLock(binding, clock, async (id) => {
    const paths = partitionPaths(binding);
    const found = await inventory(paths.directory, clock);
    const snapshot = await current(binding, codec, found.state, clock);
    for (const temp of found.temps) {
      if (!await remove(join(paths.directory, temp.name), temp.info, false, clock)) fail("IO_UNAVAILABLE", false);
    }
    if (!await remove(paths.lock, id, true, clock)) fail("IO_UNAVAILABLE", false, true);
    return { status: "recovered", generation: snapshot?.generation ?? 0, discardedTemps: found.temps.length,
      lockReleased: true, warnings: [] };
  });
}
