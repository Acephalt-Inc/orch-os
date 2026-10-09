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
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pidAlive, renameRetry, sleepSync } from "./util.js";

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
const BREAK_STALE_MS = 10_000;
// Windows cannot remove a directory while another process still has a file in it open: retry briefly there.
const REMOVE = process.platform === "win32"
  ? { recursive: true, force: true, maxRetries: 10, retryDelay: 10 } : { recursive: true, force: true };

function readOwner(dir: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(dir + "/owner.json", "utf8"));
    if (o && typeof o.token === "string") return o as Owner;
  } catch { /* missing or half-written */ }
  return null;
}

function ageMs(p: string, now: number): number | null {
  try {
    return now - statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** What we saw when we judged the lock stale: its token, or its mtime when owner.json was missing. */
function staleMark(dir: string, staleMs: number): string | null {
  const now = Date.now();
  const o = readOwner(dir);
  if (o) {
    const dead = o.host === hostname() && !pidAlive(o.pid, false);
    const old = now - o.created_ms > staleMs;
    return dead || old ? "token:" + o.token : null;
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

function tryBreak(dir: string, mark: string): void {
  const brk = dir + ".break";
  try {
    mkdirSync(brk);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const age = ageMs(brk, Date.now());
    if (age !== null && age > BREAK_STALE_MS) {
      try {
        rmdirSync(brk);
      } catch { /* someone else did */ }
    }
    return;
  }
  try {
    if (currentMark(dir) === mark) {
      const aside = `${dir}.stale.${process.pid}.${randomUUID()}`;
      try {
        renameSync(dir, aside);
        rmSync(aside, REMOVE);
      } catch { /* gone already */ }
    }
  } finally {
    try {
      rmdirSync(brk);
    } catch { /* ignore */ }
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
        writeFileSync(this.path + "/owner.json", JSON.stringify(owner));
        this.token = token;
        return;
      } catch (e: any) {
        if (e.code === "ENOENT") {
          mkdirSync(dirname(this.path), { recursive: true });
          continue;
        }
        if (e.code !== "EEXIST") throw e;
      }
      const mark = staleMark(this.path, staleMs);
      if (mark) {
        tryBreak(this.path, mark);
        continue;
      }
      if (Date.now() - start > timeout) throw new LockTimeoutError(this.path, timeout);
      sleepSync(wait + Math.random() * wait);
      wait = Math.min(wait * 2, 25);
    }
  }

  release(): void {
    const token = this.token;
    this.token = null;
    if (!token) return;
    const o = readOwner(this.path);
    if (!o || o.token !== token) throw new LockLostError(this.path);
    // rename aside before deleting, so a waiter never sees a half-removed lock directory.
    // On Windows the rename is refused while a waiter is reading owner.json; renameRetry waits that out
    // (the lock is still ours until the rename succeeds).
    const aside = `${this.path}.rel.${process.pid}.${token}`;
    renameRetry(this.path, aside);
    rmSync(aside, REMOVE);
  }
}

/** Run fn while holding the lock at `path`; the lock is released even if fn throws. */
export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const l = new FileLock(path, opts);
  l.acquire();
  let ok = false;
  try {
    const r = fn();
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
