// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Cross-process exclusive lock built on atomic mkdir (Node has no flock).
 *
 * acquire: mkdir(<path>) succeeds for exactly one process; the winner writes owner.json
 *          ({pid, host, token, created_ms}) inside it. Everyone else polls with a short,
 *          jittered backoff until it can mkdir, or until the timeout (LockTimeoutError).
 * recovery: a lock left behind by a holder that died is removed by the next caller.
 * release: removes the lock only if it still carries our token; otherwise LockLostError
 *          (someone judged us stale), which callers surface instead of ignoring.
 */
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pidAlive, sleepSync, withWriteGuard } from "./util.js";

export class LockTimeoutError extends Error {
  constructor(path: string, ms: number) {
    super(`lock busy: ${path} (waited ${Math.round(ms / 1000)}s)`);
    this.name = "LockTimeoutError";
  }
}

export class LockLostError extends Error {
  constructor(path: string) {
    super(`lock lost while held: ${path}`);
    this.name = "LockLostError";
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

interface Owner {
  pid: number;
  host: string;
  token: string;
  created_ms: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
export class LockOwnerError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`unknown lock owner: ${file} (${reason})`);
    this.name = "LockOwnerError";
  }
}

function readOwner(dir: string): Owner | null {
  const file = dir + "/owner.json";
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (e: any) {
    if (e.code === "ENOENT") {
      // A new complete owner can appear between read and lstat; that is a normal acquisition race.
      try { if (!lstatSync(file).isSymbolicLink()) return null; }
      catch (missing: any) { if (missing.code === "ENOENT") return null; }
    }
    throw new LockOwnerError(file, e.code ?? "cannot read");
  }
  let o: any;
  try { o = JSON.parse(text); }
  catch { throw new LockOwnerError(file, "invalid JSON"); }
  if (!o || typeof o.token !== "string" || !o.token || typeof o.host !== "string" || !o.host ||
      !Number.isSafeInteger(o.pid) || o.pid <= 0 || !Number.isFinite(o.created_ms)) {
    throw new LockOwnerError(file, "invalid owner record");
  }
  return o as Owner;
}

/** What we saw when we judged the lock stale: its token, or its mtime when owner.json was missing. */
function staleMark(dir: string, staleMs: number): string | null {
  const now = Date.now();
  const o = readOwner(dir);
  if (o) {
    const dead = o.host === hostname() && !pidAlive(o.pid, false);
    const old = now - o.created_ms > staleMs;
    return dead || (o.host !== hostname() && old) ? "token:" + o.token : null;
  }
  let mtime: number;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {
    return null; // vanished: just retry
  }
  return now - mtime > staleMs ? "mtime:" + mtime : null;
}

function currentMark(dir: string): string | null {
  const o = readOwner(dir);
  if (o) return "token:" + o.token;
  try {
    return "mtime:" + statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

// Publication and stale removal share this exclusion. Never age-break it: its holder may be paused.
function takeExclusion(dir: string): boolean {
  try { mkdirSync(dir + ".break"); return true; }
  catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    return false;
  }
}

function dropExclusion(dir: string): void {
  try { rmdirSync(dir + ".break"); } catch { /* ignore */ }
}

function tryBreak(dir: string, mark: string, staleMs: number): void {
  if (!takeExclusion(dir)) return;
  try {
    if (currentMark(dir) === mark && staleMark(dir, staleMs) === mark) {
      const aside = `${dir}.stale.${process.pid}.${randomUUID()}`;
      try {
        renameSync(dir, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch { /* gone already */ }
    }
  } finally {
    dropExclusion(dir);
  }
}

export class FileLock {
  private token: string | null = null;
  constructor(readonly path: string, readonly opts: LockOptions = {}) {}

  acquire(): void {
    const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleMs = this.opts.staleMs ?? DEFAULT_STALE_MS;
    const start = Date.now();
    let wait = 1;
    for (;;) {
      try {
        mkdirSync(this.path, { mode: 0o700 });
        const token = randomUUID();
        const owner: Owner = { pid: process.pid, host: hostname(), token, created_ms: Date.now() };
        // Publish a complete record exclusively: a paused initializer cannot overwrite a new owner.
        const identity = statSync(this.path);
        while (!takeExclusion(this.path)) {
          if (Date.now() - start > timeout) throw new LockTimeoutError(this.path, timeout);
          sleepSync(wait + Math.random() * wait);
          wait = Math.min(wait * 2, 25);
        }
        try {
          // A breaker may have displaced this initializer while publication waited for exclusion.
          const current = statSync(this.path);
          if (current.dev !== identity.dev || current.ino !== identity.ino) throw new LockLostError(this.path);
          const tmp = `${this.path}/.owner-${token}`;
          writeFileSync(tmp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
          linkSync(tmp, this.path + "/owner.json");
          unlinkSync(tmp);
          this.token = token;
          return;
        } finally { dropExclusion(this.path); }
      } catch (e: any) {
        if (e.code === "ENOENT") {
          mkdirSync(dirname(this.path), { recursive: true });
          continue;
        }
        if (e.code !== "EEXIST") throw e;
      }
      const mark = staleMark(this.path, staleMs);
      if (mark) {
        tryBreak(this.path, mark, staleMs);
      }
      if (Date.now() - start > timeout) throw new LockTimeoutError(this.path, timeout);
      sleepSync(wait + Math.random() * wait);
      wait = Math.min(wait * 2, 25);
    }
  }

  /** Fence before an effect, rather than discovering lost ownership only at release. */
  assertHeld(): void {
    const o = readOwner(this.path);
    if (!this.token || !o || o.token !== this.token) throw new LockLostError(this.path);
  }

  release(): void {
    const token = this.token;
    this.token = null;
    if (!token) return;
    const o = readOwner(this.path);
    if (!o || o.token !== token) throw new LockLostError(this.path);
    // rename aside before deleting, so a waiter never sees a half-removed lock directory
    const aside = `${this.path}.rel.${process.pid}.${token}`;
    renameSync(this.path, aside);
    rmSync(aside, { recursive: true, force: true });
  }
}

/** Run fn while holding the lock at `path`; the lock is released even if fn throws. */
export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const l = new FileLock(path, opts);
  l.acquire();
  let ok = false;
  try {
    const r = withWriteGuard(() => l.assertHeld(), fn);
    ok = true;
    return r;
  } finally {
    try {
      l.release();
    } catch (e) {
      if (ok) throw e; // a lost lock after a successful critical section must be reported
    }
  }
}
