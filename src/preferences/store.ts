// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assertPreference, isPreferenceKey, parseState, PreferenceError, type PreferenceKey, type PreferenceState, type PreferenceValue, type PreferenceView } from "./schema.js";

// A writer that finds the lock held retries in short steps for at most two seconds, well inside
// the five-second bound of a command.
const LOCK_WAIT_MS = 2_000;
const LOCK_STEP_MS = 25;
const LOCK_HELD = "a set or unset is still running or was interrupted; when none is running, remove the .lock folder in this workspace's folder under .orch-private/preferences-v1 and retry";
/** Reported on standard error, with status 0, when a change was written and its lock could not be removed. */
export const LOCK_LEFT = "the change was written, but the .lock folder could not be removed; when no set or unset is running, remove the .lock folder in this workspace's folder under .orch-private/preferences-v1 before the next set or unset";
/** Reported on standard error, with status 0, when an installed change could not be flushed. */
export const DIRECTORY_NOT_FLUSHED = "the change was written, but the preferences folder could not be flushed; verify the saved preference before retrying";
const TEMPORARY = /^\.state-\d+-[0-9a-f]{16}\.tmp$/;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1_000;

export type WritePoint = "locked" | "temp-flushed" | "renamed";

/**
 * Test seam for one change. The command never passes one: it is a set of functions, so it cannot be
 * expressed in an argument, an environment variable or standard input.
 */
export interface StoreSeam {
  at?: (point: WritePoint) => void | Promise<void>;
  sync?: (handle: FileHandle) => Promise<void>;
  openDirectory?: (path: string) => Promise<FileHandle>;
  removeLock?: (path: string) => Promise<void>;
  beforeStateOpen?: () => void | Promise<void>;
  platform?: NodeJS.Platform;
  uid?: number;
}

/** The result of one change: the settings now in place, and whether the writer lock was removed afterwards. */
export interface PreferenceChange { view: PreferenceView; directoryFlushed: boolean; lockReleased: boolean; }

function emptyState(): PreferenceState { return { version: 1, revision: 0, preferences: {} }; }

/**
 * The workspace path that identifies a store. A path that is, or passes through, a link is refused:
 * each part is looked at without following it.
 */
export async function canonicalWorkspace(input: string): Promise<string> {
  if (!input || input.includes("\0")) throw new PreferenceError("unavailable", "unsafe workspace path");
  const absolute = resolve(input);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (part === "") continue;
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new PreferenceError("unavailable", "unsafe workspace path");
  }
  if (!(await lstat(absolute)).isDirectory()) throw new PreferenceError("unavailable", "unsafe workspace path");
  return realpath(absolute);
}

export function workspaceDigest(canonical: string, pathApi: Pick<typeof import("node:path").win32, "normalize" | "parse"> = { normalize: (v: string) => v, parse }): string {
  const normalized = pathApi.normalize(canonical);
  return createHash("sha256").update(normalized).digest("hex");
}

async function locations(workspace: string) {
  const canonical = await canonicalWorkspace(workspace);
  const home = await realpath(homedir());
  const base = join(home, ".orch-private");
  const root = join(base, "preferences-v1");
  const directory = join(root, workspaceDigest(canonical));
  return { base, root, directory, state: join(directory, "state.json"), lock: join(directory, ".lock") };
}

/**
 * Look at one storage folder without following it. Returns false when nothing is there. Anything
 * that is there must be a plain folder: a link in its place is refused, never followed.
 */
async function plainDirectory(path: string, seam: StoreSeam = {}): Promise<boolean> {
  if ((seam.platform ?? process.platform) !== "win32") {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new PreferenceError("unavailable", "unsafe preference path");
    }
    try {
      const info = await handle.stat();
      const uid = seam.uid ?? process.getuid!();
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
        throw new PreferenceError("unavailable", "unsafe preference path");
      }
      return true;
    } finally {
      await handle.close();
    }
  }
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  // lstat describes a link itself, not what it points at, so a link is never a directory here.
  if (!info.isDirectory()) throw new PreferenceError("unavailable", "unsafe preference path");
  return true;
}

async function ensurePrivate(loc: Awaited<ReturnType<typeof locations>>, seam: StoreSeam) {
  for (const directory of [loc.base, loc.root, loc.directory]) {
    if (!(await plainDirectory(directory, seam))) {
      // Another writer may create it first, so "already there" is not an error: it is looked at again.
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!(await plainDirectory(directory, seam))) throw new PreferenceError("unavailable", "unsafe preference path");
    }
  }
}

async function read(loc: Awaited<ReturnType<typeof locations>>, seam: StoreSeam = {}): Promise<PreferenceState> {
  // Each folder on the way is looked at first, so state is never reached through a link put in its place.
  for (const directory of [loc.base, loc.root, loc.directory]) {
    if (!(await plainDirectory(directory, seam))) return emptyState();
  }
  try {
    await seam.beforeStateOpen?.();
    if ((seam.platform ?? process.platform) === "win32") {
      const info = await lstat(loc.state);
      if (!info.isFile() || info.nlink !== 1) throw new PreferenceError("unavailable", "unsafe preference state");
      return parseState(await readFile(loc.state, "utf8"));
    }
    const handle = await open(loc.state, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new PreferenceError("unavailable", "unsafe preference state");
      return parseState(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PreferenceError("unavailable", "unsafe preference state");
    throw error;
  }
}

/**
 * Run the action while holding the writer lock, waiting a bounded time while another writer holds
 * it. A lock that is still held at the bound is reported and left alone: it is never removed or
 * taken over here.
 */
async function withLock(loc: Awaited<ReturnType<typeof locations>>, seam: StoreSeam, action: () => Promise<{ view: PreferenceView; directoryFlushed: boolean }>): Promise<PreferenceChange> {
  // A monotonic clock: a change of the wall clock cannot lengthen or shorten the wait.
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    try { await mkdir(loc.lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new PreferenceError("unavailable", LOCK_HELD);
      await new Promise((done) => setTimeout(done, LOCK_STEP_MS));
    }
  }
  const release = () => (seam.removeLock ?? ((path: string) => rm(path, { recursive: true, force: true })))(loc.lock);
  let result: { view: PreferenceView; directoryFlushed: boolean };
  try { await seam.at?.("locked"); result = await action(); }
  catch (error) {
    // Nothing was acknowledged, so the caller is told this refusal. If the lock cannot be removed
    // either, it stays, and the next writer reports it as a held lock.
    try { await release(); } catch { /* reported by the next writer */ }
    throw error;
  }
  // The state is in place. From here the change is reported as made, whatever happens to the lock.
  try { await release(); } catch { return { ...result, lockReleased: false }; }
  return { ...result, lockReleased: true };
}

async function writeAtomic(loc: Awaited<ReturnType<typeof locations>>, state: PreferenceState, seam: StoreSeam): Promise<boolean> {
  const sync = seam.sync ?? ((handle: FileHandle) => handle.sync());
  const temporary = join(loc.directory, `.state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    // Created with owner-only permission, so the state needs no permission change after the rename.
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(state)}\n`); await sync(handle); } finally { await handle.close(); }
    await seam.at?.("temp-flushed");
    await rename(temporary, loc.state);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await seam.at?.("renamed");
  // The new state is in place. Windows cannot open a directory to flush it, so the directory
  // flush is skipped there: an error at this step must not report a write that happened as failed.
  if ((seam.platform ?? process.platform) === "win32") return true;
  try {
    const directory = await (seam.openDirectory ?? ((path: string) => open(path, "r")))(loc.directory);
    try { await sync(directory); } finally { await directory.close(); }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove temporary files that an interrupted writer left behind. Call it only while holding the
 * lock: no other cooperating writer can then own a temporary file here.
 */
async function removeLeftovers(loc: Awaited<ReturnType<typeof locations>>) {
  for (const name of await readdir(loc.directory)) {
    if (TEMPORARY.test(name)) await unlink(join(loc.directory, name));
  }
}

function view(state: PreferenceState, now: number): PreferenceView {
  const preferences: PreferenceView["preferences"] = {};
  const expiry: PreferenceView["expiry"] = {};
  for (const [key, item] of Object.entries(state.preferences) as [PreferenceKey, NonNullable<PreferenceState["preferences"][PreferenceKey]>][]) {
    if (now < Date.parse(item.expires_at)) { (preferences as Record<string, string>)[key] = item.value; expiry[key] = item.expires_at; }
  }
  return { source: "explicit-command", revision: state.revision, preferences, expiry };
}

export async function showPreferences(workspace: string, now = Date.now(), seam: StoreSeam = {}): Promise<PreferenceView> {
  return view(await read(await locations(workspace), seam), now);
}

export async function setPreference(workspace: string, key: string, value: string, expectedRevision: number, now = Date.now(), seam: StoreSeam = {}): Promise<PreferenceChange> {
  assertPreference(key, value);
  const loc = await locations(workspace); await ensurePrivate(loc, seam);
  return withLock(loc, seam, async () => {
    // Read only now, with the lock held: a writer that waited sees what the previous holder left.
    const state = await read(loc, seam);
    if (state.revision !== expectedRevision) throw new PreferenceError("conflict", "preference revision conflict");
    await removeLeftovers(loc);
    state.revision++; state.preferences[key] = { value: value as PreferenceValue, expires_at: new Date(now + EXPIRY_MS).toISOString() };
    const directoryFlushed = await writeAtomic(loc, state, seam);
    return { view: view(state, now), directoryFlushed };
  });
}

export async function unsetPreference(workspace: string, key: string, expectedRevision: number, now = Date.now(), seam: StoreSeam = {}): Promise<PreferenceChange> {
  if (!isPreferenceKey(key)) throw new PreferenceError("invalid", "invalid preference key or value");
  const loc = await locations(workspace); await ensurePrivate(loc, seam);
  return withLock(loc, seam, async () => {
    const state = await read(loc, seam);
    if (state.revision !== expectedRevision) throw new PreferenceError("conflict", "preference revision conflict");
    await removeLeftovers(loc);
    state.revision++;
    delete state.preferences[key];
    const directoryFlushed = await writeAtomic(loc, state, seam);
    return { view: view(state, now), directoryFlushed };
  });
}
