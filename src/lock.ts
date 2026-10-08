// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * One local host, cooperating processes, synchronous callbacks.
 * Exclusive mkdir ownership lasts until this owner's release. A complete linked
 * owner record precedes the callback; callback completion precedes release rename.
 * No online lock breaking: dead or interrupted owners require a quiescent reset.
 */
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sleepSync, withWriteGuard } from "./util.js";

function recovery(path: string): string {
  return `stop every orch process and disable new launches, then remove the named lock directory ${path}; preserve lease, epoch, author and journal files (docs/commands.md)`;
}

export class LockTimeoutError extends Error {
  constructor(path: string, ms: number) {
    super(`lock busy: ${path} (waited ${Math.round(ms / 1000)}s); no automatic recovery; ${recovery(path)}`);
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
  /** Retained for callers; age never permits lock removal. */
  staleMs?: number;
}

interface Owner {
  pid: number;
  host: string;
  token: string;
  created_ms: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export class LockOwnerError extends Error {
  constructor(readonly file: string, reason: string, dir = dirname(file)) {
    super(`unknown lock owner: ${file} (${reason}); ${recovery(dir)}`);
    this.name = "LockOwnerError";
  }
}

function residual(dir: string): string {
  try {
    const entries = readdirSync(dir).sort();
    return `${dir} remains; ${entries.includes("owner.json") ? "owner record remains" : "ownerless directory"}; entries=${JSON.stringify(entries)}`;
  } catch (e: any) {
    return e.code === "ENOENT" ? `${dir} absent` : `${dir}: state unknown (${e.code ?? "inspection failed"})`;
  }
}

export class LockCleanupError extends Error {
  constructor(readonly operation: string, readonly path: string, readonly errno: string,
              readonly stage: string, readonly state: string, cause: unknown, resetDir: string) {
    super(`lock cleanup failed: ${operation} ${path}: ${errno}; ${stage}; ${state}; ${recovery(resetDir)}`, { cause });
    this.name = "LockCleanupError";
  }
}

function cleanup(operation: string, path: string, dir: string, stage: string, action: () => void): void {
  try { action(); }
  catch (e: any) { throw new LockCleanupError(operation, path, e.code ?? "unknown errno", stage, residual(dir), e, dir); }
}

function both(first: unknown, second: unknown): AggregateError {
  return new AggregateError([first, second], `${first instanceof Error ? first.message : String(first)}; ${second instanceof Error ? second.message : String(second)}`);
}

function readOwner(dir: string): Owner | null {
  const file = dir + "/owner.json";
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (e: any) {
    if (e.code === "ENOENT") {
      // Publication or the owner's release can race this read. A dangling link is unknown.
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

export class FileLock {
  private token: string | null = null;
  constructor(readonly path: string, readonly opts: LockOptions = {}) {}

  acquire(): void {
    const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    let wait = 1;
    for (;;) {
      // Legacy exclusion is refused, never created, used or removed online.
      const legacy = this.path + ".break";
      try {
        lstatSync(legacy);
        throw new LockOwnerError(legacy, "legacy breaker artifact", legacy);
      } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      let acquired = false;
      try { mkdirSync(this.path, { mode: 0o700 }); acquired = true; }
      catch (e: any) {
        if (e.code === "ENOENT") { mkdirSync(dirname(this.path), { recursive: true }); continue; }
        if (e.code !== "EEXIST") throw e;
      }
      if (acquired) {
        const token = randomUUID();
        const owner: Owner = { pid: process.pid, host: hostname(), token, created_ms: Date.now() };
        const tmp = `${this.path}/.owner-${token}`;
        try {
          writeFileSync(tmp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
          linkSync(tmp, this.path + "/owner.json");
        } catch (initializationError) {
          try {
            // Only this mkdir winner cleans its unpublished initialization.
            cleanup("unlink", tmp, this.path, "callback not entered; initialization failed", () => {
              try { unlinkSync(tmp); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
            });
            cleanup("rmdir", this.path, this.path, "callback not entered; initialization failed", () => rmdirSync(this.path));
          } catch (cleanupError) { throw both(initializationError, cleanupError); }
          throw initializationError;
        }
        cleanup("unlink", tmp, this.path, "callback not entered; owner published", () => unlinkSync(tmp));
        this.token = token;
        return;
      }
      const owner = readOwner(this.path);
      if (Date.now() - start > timeout) {
        if (!owner) throw new LockOwnerError(this.path + "/owner.json", "ownerless directory after initialization wait");
        throw new LockTimeoutError(this.path, timeout);
      }
      sleepSync(wait + Math.random() * wait);
      wait = Math.min(wait * 2, 25);
    }
  }

  /** Fence before an effect, rather than discovering lost ownership only at release. */
  assertHeld(): void {
    const o = readOwner(this.path);
    if (!this.token || !o || o.token !== this.token) throw new LockLostError(this.path);
  }

  release(stage = "callback/effects ended; effects may already be committed"): void {
    const token = this.token;
    this.token = null;
    if (!token) return;
    const o = readOwner(this.path);
    if (!o || o.token !== token) throw new LockLostError(this.path);
    // Only the owner renames, after all callback effects have ended.
    const aside = `${this.path}.rel.${process.pid}.${token}`;
    cleanup("rename", this.path, this.path, stage, () => renameSync(this.path, aside));
    cleanup("unlink", aside + "/owner.json", aside, stage, () => unlinkSync(aside + "/owner.json"));
    cleanup("rmdir", aside, aside, stage, () => rmdirSync(aside));
  }
}

/** Run a synchronous callback and report both callback and release failures. */
export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const l = new FileLock(path, opts);
  l.acquire();
  let result: T;
  let failed = false, callbackError: unknown;
  try { result = withWriteGuard(() => l.assertHeld(), fn); }
  catch (e) { failed = true; callbackError = e; }
  try { l.release(`callback ${failed ? "failed" : "completed"}; effects may already be committed`); }
  catch (e) {
    if (failed) {
      // The same ownership refusal can be observed by the guard and release.
      if (((callbackError instanceof LockLostError && e instanceof LockLostError) ||
           (callbackError instanceof LockOwnerError && e instanceof LockOwnerError)) && callbackError.message === e.message) throw callbackError;
      throw both(callbackError, e);
    }
    throw e;
  }
  if (failed) throw callbackError;
  return result!;
}
