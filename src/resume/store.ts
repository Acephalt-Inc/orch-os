// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, statfsSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { parseRecord, ResumeError, type ResumeNote, type ResumeRecord } from "./schema.js";

const NETWORK_FS = new Set([0x6969, 0x517b, 0xff534d42, 0x65735546]);
// A writer that finds the lock held retries in short steps for at most two seconds, well inside
// the five-second bound of a command.
const LOCK_WAIT_MS = 2_000;
const LOCK_STEP_MS = 25;
const LOCK_HELD = "a save or forget is still running or was interrupted; when none is running, remove the write.lock folder in this workspace's folder under .orch-private/resume-v1 and retry";
/** Reported on standard error, with status 0, when a write was made and its lock could not be removed. */
export const LOCK_LEFT = "the change was written, but the write.lock folder could not be removed; when no save or forget is running, remove the write.lock folder in this workspace's folder under .orch-private/resume-v1 before the next save or forget";
/** Reported on standard error, with status 0, when the record was installed but its folder could not be flushed. */
export const DIRECTORY_NOT_FLUSHED = "the change was written, but the note storage folder could not be flushed; verify the saved note before retrying";
const TEMPORARY = /^\.state-[0-9a-f-]{36}\.tmp$/;
const PAUSE_CELL = new Int32Array(new SharedArrayBuffer(4));

export interface ResumeLocation { directory: string; state: string; lock: string; }

export type WritePoint = "locked" | "temp-flushed" | "renamed";

/**
 * Test seam for one write. The command never passes one: it is a set of functions, so it cannot be
 * expressed in an argument, an environment variable or standard input.
 */
export interface WriteSeam {
  at?: (point: WritePoint) => void;
  fsync?: (fd: number) => void;
  openDirectory?: (path: string) => number;
  removeLock?: (path: string) => void;
  platform?: NodeJS.Platform;
  uid?: number;
  beforeRecordOpen?: (path: string) => void;
}

/** The result of one write, including warnings for durability and lock cleanup after installation. */
export interface WriteResult { record: ResumeRecord; directoryFlushed: boolean; lockReleased: boolean; }

/**
 * Look at one storage folder without following it. Returns false when nothing is there. Anything
 * that is there must be a plain private folder: a link in its place is refused, never followed.
 */
function plainDirectory(path: string, seam: WriteSeam = {}): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  // lstat describes a link itself, not what it points at, so a link is never a directory here.
  if (!stat.isDirectory()) throw new ResumeError("unavailable", "unsafe storage directory");
  if ((seam.platform ?? process.platform) === "win32") return true;
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a named pipe put in this place makes the open return at once instead of waiting for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    stat = fstatSync(fd);
  } catch {
    throw new ResumeError("unavailable", "unsafe storage directory");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!stat.isDirectory()) throw new ResumeError("unavailable", "unsafe storage directory");
  if (stat.uid !== (seam.uid ?? process.getuid?.())) throw new ResumeError("unavailable", "unsafe storage directory");
  if ((stat.mode & 0o077) !== 0) throw new ResumeError("unavailable", "storage directory is not private");
  return true;
}

/** Accept the directory only as a plain private directory, creating it when nothing is there. */
function ensurePlainDirectory(path: string, seam: WriteSeam = {}): void {
  if (plainDirectory(path, seam)) return;
  // Another writer may create it first, so "already there" is not an error: it is looked at again.
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!plainDirectory(path, seam)) throw new ResumeError("unavailable", "unsafe storage directory");
}

/** Refuse a path that is, or passes through, a link: each part is looked at without following it. */
function refuseLinks(absolute: string): void {
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (part === "") continue;
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("the path contains a link");
  }
}

export function locate(workspace: string, seam: WriteSeam = {}): ResumeLocation {
  let canonical: string;
  let home: string;
  try {
    const requestedWorkspace = resolve(workspace);
    const requestedHome = resolve(homedir());
    refuseLinks(requestedWorkspace);
    if (lstatSync(requestedHome).isSymbolicLink()) throw new Error();
    canonical = realpathSync(requestedWorkspace);
    home = realpathSync(requestedHome);
    const ws = lstatSync(canonical);
    if (!ws.isDirectory() || ws.isSymbolicLink()) throw new Error();
    if (process.platform === "linux" && NETWORK_FS.has(Number(statfsSync(home).type))) throw new ResumeError("unavailable", "remote home storage is unsupported");
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError("unavailable", "workspace or home is unavailable");
  }
  const digest = createHash("sha256").update(canonical).digest("hex");
  const privateRoot = join(home, ".orch-private");
  const versionRoot = join(privateRoot, "resume-v1");
  try {
    ensurePlainDirectory(privateRoot, seam);
    ensurePlainDirectory(versionRoot, seam);
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError("unavailable", "private storage is unavailable");
  }
  const directory = join(versionRoot, digest);
  return { directory, state: join(directory, "state.json"), lock: join(directory, "write.lock") };
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" ? (() => { throw error; })() : false; }
}

function read(location: ResumeLocation, seam: WriteSeam = {}): ResumeRecord | undefined {
  // The folder is looked at first, so a record is never reached through a link put in its place.
  if (!plainDirectory(location.directory, seam)) return undefined;
  if ((seam.platform ?? process.platform) === "win32") {
    if (!exists(location.state)) return undefined;
    const stat = lstatSync(location.state);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ResumeError("unavailable", "unsafe state file");
  }
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a named pipe put in the record's place is opened at once and then refused as not a file.
    const flags = constants.O_RDONLY | ((seam.platform ?? process.platform) === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    seam.beforeRecordOpen?.(location.state);
    fd = openSync(location.state, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new ResumeError("unavailable", "unsafe state file");
    return parseRecord(readFileSync(fd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof ResumeError) throw error;
    throw new ResumeError("unavailable", "unsafe state file");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWrite(location: ResumeLocation, record: ResumeRecord, seam: WriteSeam): boolean {
  const fsync = seam.fsync ?? fsyncSync;
  const temporary = join(location.directory, `.state-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsync(fd);
    closeSync(fd);
    fd = undefined;
    seam.at?.("temp-flushed");
    renameSync(temporary, location.state);
    renamed = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) rmSync(temporary, { force: true });
  }
  // The new record is in place. Windows cannot open a directory to flush it, so the directory
  // flush is skipped there: an error at this step must not report a write that happened as failed.
  try {
    seam.at?.("renamed");
    if ((seam.platform ?? process.platform) === "win32") return true;
    const openDirectory = seam.openDirectory
      ?? ((path: string) => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const dirfd = openDirectory(location.directory);
    try {
      fsync(dirfd);
    } finally {
      closeSync(dirfd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove temporary files that an interrupted writer left behind. Call it only while holding the
 * lock: no other cooperating writer can then own a temporary file here.
 */
function removeLeftovers(location: ResumeLocation): void {
  for (const name of readdirSync(location.directory)) {
    if (TEMPORARY.test(name)) unlinkSync(join(location.directory, name));
  }
}

export function show(workspace: string, seam: WriteSeam = {}): ResumeRecord | undefined { return read(locate(workspace, seam), seam); }

export function write(workspace: string, expectedRevision: number, note?: ResumeNote, seam: WriteSeam = {}): WriteResult {
  const location = locate(workspace, seam);
  const unlock = lock(location, seam);
  let record: ResumeRecord;
  let directoryFlushed: boolean;
  try {
    seam.at?.("locked");
    // Read only now, with the lock held: a writer that waited sees what the previous holder left.
    const prior = read(location, seam);
    const current = prior?.revision ?? 0;
    if (current !== expectedRevision) throw new ResumeError("conflict", "revision conflict");
    removeLeftovers(location);
    record = { schema: 1, id: randomUUID(), revision: current + 1, saved_at: new Date().toISOString(), ...(note === undefined ? {} : { note }) };
    directoryFlushed = atomicWrite(location, record, seam);
  } catch (error) {
    // Nothing was acknowledged, so the caller is told this refusal. If the lock cannot be removed
    // either, it stays, and the next writer reports it as a held lock.
    try { unlock(); } catch { /* reported by the next writer */ }
    throw error;
  }
  // The record is in place. From here the write is reported as made, whatever happens to the lock.
  try { unlock(); } catch { return { record, directoryFlushed, lockReleased: false }; }
  return { record, directoryFlushed, lockReleased: true };
}

/**
 * Take the writer lock, waiting a bounded time while another writer holds it. A lock that is still
 * held at the bound is reported and left alone: it is never removed or taken over here.
 */
function lock(location: ResumeLocation, seam: WriteSeam): () => void {
  try {
    ensurePlainDirectory(location.directory, seam);
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError("unavailable", "unsafe workspace state directory");
  }
  // A monotonic clock: a change of the wall clock cannot lengthen or shorten the wait.
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(location.lock, { mode: 0o700 });
      return () => (seam.removeLock ?? rmdirSync)(location.lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ResumeError("unavailable", "unsafe workspace state directory");
      if (performance.now() >= deadline) throw new ResumeError("unavailable", LOCK_HELD);
      Atomics.wait(PAUSE_CELL, 0, 0, LOCK_STEP_MS);
    }
  }
}
