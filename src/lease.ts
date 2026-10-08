// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Single-holder role lease: lock-serialized writes, verified by reading back under the same lock.
 *
 *   * freshness is judged against the stored expiry, not the duration a caller asks for;
 *   * a requested duration below minSeconds is raised to minSeconds;
 *   * every change of holder increments the epoch, so a former holder can be fenced off;
 *   * a different holder with an unexpired lease blocks acquire unless force is set.
 * Corrupt/unknown files block every action. Explicit acquire recovery requires an epoch floor.
 * The separate epoch/history record is written before each lease publication, under the same lock.
 * Exit codes: 0 ok / 3 busy (another holder) / 4 not the holder, expired, or stale epoch / 5 write not verified / 6 CORRUPT or UNKNOWN.
 */
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { withLock } from "./lock.js";
import { dumps } from "./pyjson.js";
import { assertWriteOwnership, atomicWrite, isPlainObject } from "./util.js";

export type LeaseAction = "status" | "acquire" | "renew" | "release";
export const LEASE_ACTIONS: LeaseAction[] = ["status", "acquire", "renew", "release"];

export interface LeaseRunOptions {
  leaseSeconds?: number | null;
  force?: boolean;
  recover?: boolean;
  expectedEpoch?: number | null;
  now?: number | null;
  /** Keep an append-only `holders` list (every session that ever held it). Task claims use it. */
  trackHolders?: boolean;
}

/**
 * Every distinct holder on record, oldest first. Files written before `holders` existed give
 * previous_owner, session_id. The current holder (session_id) is always included, even when a
 * `holders` list exists but does not name it.
 */
export function holderHistory(state: Record<string, any>): string[] {
  const seen: string[] = [];
  const raw = Array.isArray(state.holders) ? [...state.holders, state.session_id] : [state.previous_owner, state.session_id];
  for (const h of raw) if (typeof h === "string" && h !== "" && !seen.includes(h)) seen.push(h);
  return seen;
}

export type LeaseResult = Record<string, any>;

export const LEASE_FILE_ERROR_EXIT = 6;
export class LeaseFileError extends Error {
  constructor(readonly status: "CORRUPT" | "UNKNOWN", readonly path: string,
              readonly reason: string, readonly epoch: number | null = null,
              readonly holders: string[] = []) {
    super(`${path} is ${status} (${reason})`);
    this.name = "LeaseFileError";
  }
}
function validEpoch(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Only a genuinely absent path is free; a dangling symlink is unknown. */
function readOptional(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (e: any) {
    if (e.code === "ENOENT") {
      try { lstatSync(path); }
      catch (missing: any) { if (missing.code === "ENOENT") return null; }
    }
    throw new LeaseFileError("UNKNOWN", path, `cannot read: ${e.code ?? "I/O error"}`);
  }
}
interface EpochRecord { epoch: number; holders: string[] }
interface Recovery { found: LeaseFileError; evidence: string }

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export class Lease {
  readonly lock: string;
  constructor(readonly path: string, readonly defaultSeconds = 3600, readonly minSeconds = 60) {
    this.lock = path + ".lock.d";
  }

  get epochPath(): string { return this.path + ".epoch.max"; }
  get journalPath(): string { return this.path + ".recovery.jsonl"; }

  /** Missing is free; damaged or unreadable ownership is distinct and never free. */
  load(): Record<string, any> {
    const text = readOptional(this.path);
    if (text === null) return {};
    let v: any;
    try { v = JSON.parse(text); }
    catch { throw new LeaseFileError("CORRUPT", this.path, `invalid JSON (${text.length} characters)`); }
    const obj = isPlainObject(v);
    const epoch = obj && validEpoch(v.epoch) ? v.epoch : null;
    if (!obj || typeof v.session_id !== "string" || !v.session_id || epoch === null ||
        !Number.isFinite(v.lease_expires_at) || !["ACTIVE", "RELEASED"].includes(v.state)) {
      throw new LeaseFileError("CORRUPT", this.path, "invalid lease object", epoch, obj ? holderHistory(v) : []);
    }
    return v;
  }

  private readRecord(): EpochRecord | null {
    const text = readOptional(this.epochPath);
    if (text === null) return null;
    let v: any;
    try { v = JSON.parse(text); } catch { /* handled below */ }
    if (!isPlainObject(v) || !validEpoch(v.epoch) || !Array.isArray(v.holders) ||
        !v.holders.every((h: unknown) => typeof h === "string" && h !== "")) {
      throw new LeaseFileError("CORRUPT", this.epochPath, "invalid epoch/history record");
    }
    return v as EpochRecord;
  }

  private journal(stage: "PREPARED" | "COMMITTED", recovery: Recovery, state: Record<string, any>, now: number): void {
    assertWriteOwnership();
    const fd = openSync(this.journalPath, "a", 0o600);
    try {
      assertWriteOwnership();
      appendFileSync(fd, JSON.stringify({ stage, at: now, file: this.path,
        found: { status: recovery.found.status, reason: recovery.found.reason, epoch: recovery.found.epoch },
        evidence: recovery.evidence, written: state }) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  private store(state: Record<string, any>, record: EpochRecord | null, recovery: Recovery | null, now: number): void {
    // Reserve even a skipped epoch before publishing the lease. A crash here cannot reissue it.
    const holders = [...new Set([...(record?.holders ?? []), ...holderHistory(state)])];
    atomicWrite(this.epochPath, JSON.stringify({ epoch: Math.max(record?.epoch ?? 0, state.epoch), holders }) + "\n",
      { fsync: true, mode: 0o600, tmpSuffix: ".tmp" });
    if (recovery) {
      this.journal("PREPARED", recovery, state, now);
      assertWriteOwnership();
      renameSync(this.path, recovery.evidence);
    }
    atomicWrite(this.path, dumps(state), { fsync: true, mode: 0o600, tmpSuffix: ".tmp" });
    if (recovery) this.journal("COMMITTED", recovery, state, now);
  }

  private fresh(state: Record<string, any>, now: number): boolean {
    const exp = state.lease_expires_at;
    if (exp === undefined || exp === null || typeof exp === "boolean") return false;
    const f = typeof exp === "number" ? exp : typeof exp === "string" && exp.trim() !== "" ? Number(exp) : NaN;
    return !Number.isNaN(f) && now < f;
  }

  /**
   * One lease operation. `expectedEpoch` fences renew (v1.1) and, new in v2, release too.
   * Returns [exit code, result].
   */
  run(action: string, session?: string | null, opts: LeaseRunOptions = {}): [number, LeaseResult] {
    if (!(LEASE_ACTIONS as string[]).includes(action)) throw new RangeError(action);
    if (action !== "status" && !session) throw new RangeError("session id required");
    if (opts.recover && action !== "acquire") throw new RangeError("recover is only valid for acquire");
    mkdirSync(dirname(this.path), { recursive: true });
    const req = opts.leaseSeconds === undefined || opts.leaseSeconds === null ? this.defaultSeconds : opts.leaseSeconds;
    return withLock(this.lock, () => {
      const now = opts.now === undefined || opts.now === null ? Date.now() / 1000 : opts.now;
      const refuse = (e: LeaseFileError): [number, LeaseResult] => [LEASE_FILE_ERROR_EXIT, {
        action, now: round(now, 3), holder: null, unexpired: false, epoch: null, expires_at: null,
        state: {}, status: e.status, file: e.path, error: e.reason,
      }];
      let state: Record<string, any>;
      let recovery: Recovery | null = null;
      let damaged: LeaseFileError | null = null;
      try { state = this.load(); }
      catch (e) {
        if (!(e instanceof LeaseFileError)) throw e;
        if (action !== "acquire" || !opts.recover) return refuse(e);
        damaged = e;
        state = {};
      }
      let record: EpochRecord | null;
      try { record = this.readRecord(); }
      catch (e) { if (e instanceof LeaseFileError) return refuse(e); throw e; }
      const floor = Math.max(record?.epoch ?? 0, state.epoch ?? 0, damaged?.epoch ?? 0);
      if (damaged) {
        if (!record && damaged.epoch === null) return refuse(new LeaseFileError(damaged.status, this.path,
          `${damaged.reason}; last epoch unknown: ${this.epochPath} missing; recovery refused`));
        recovery = { found: damaged, evidence: `${this.path}.corrupt-${Math.trunc(now)}-${randomUUID()}` };
      }
      const owner = state.session_id;
      const fresh = this.fresh(state, now);
      const r: LeaseResult = {
        action, now: round(now, 3), holder: owner ?? null, unexpired: fresh,
        epoch: state.epoch ?? null, expires_at: state.lease_expires_at ?? null, state,
      };
      if (action === "status") {
        r.status = owner && fresh ? "HELD" : "FREE";
        r.state = state;
        return [0, r];
      }
      if (action === "release") {
        if (owner !== session) {
          r.status = "NOT_HOLDER";
          return [4, r];
        }
        if (opts.expectedEpoch !== undefined && opts.expectedEpoch !== null && opts.expectedEpoch !== state.epoch) {
          r.status = "STALE_EPOCH";
          return [4, r];
        }
        Object.assign(state, { lease_expires_at: 0, state: "RELEASED", released_at: now });
        this.store(state, record, recovery, now);
        r.status = "RELEASED";
        r.state = this.load();
        return [0, r];
      }
      if (action === "renew") {
        if (owner !== session) {
          r.status = "NOT_HOLDER";
          return [4, r];
        }
        if (!fresh || state.state !== "ACTIVE") {
          r.status = "EXPIRED";
          return [4, r];
        }
        if (opts.expectedEpoch !== undefined && opts.expectedEpoch !== null && opts.expectedEpoch !== state.epoch) {
          r.status = "STALE_EPOCH";
          return [4, r];
        }
      } else {
        // acquire
        if (owner && owner !== session && fresh && !opts.force) {
          r.status = "BUSY";
          return [3, r];
        }
        if (owner !== session || state.state !== "ACTIVE" || !fresh) {
          if (floor >= Number.MAX_SAFE_INTEGER) return refuse(new LeaseFileError("CORRUPT", this.epochPath, "epoch exhausted"));
          const history = [...new Set([...(record?.holders ?? []), ...(damaged?.holders ?? []), ...holderHistory(state)])];
          state = { acquired_at: now, previous_owner: owner ?? null, epoch: floor + 1, state: "ACTIVE" };
          if (recovery) state.recovered_from = recovery.evidence;
          if (opts.force && owner && owner !== session) state.forced_takeover = true;
          if (opts.trackHolders) state.holders = history.includes(session!) ? history : [...history, session];
        } else if (opts.trackHolders && !Array.isArray(state.holders)) {
          state.holders = holderHistory(state); // an old file, re-claimed by its holder
        }
      }
      const effective = Math.max(Math.trunc(req), this.minSeconds);
      Object.assign(state, {
        session_id: session, heartbeat: now, lease_seconds: effective, lease_expires_at: now + effective, state: "ACTIVE",
      });
      if (opts.trackHolders) state.holders = [...new Set([...(record?.holders ?? []), ...holderHistory(state)])];
      this.store(state, record, recovery, now);
      const back = this.load(); // same lock still held
      r.lease_seconds_raised = effective !== Math.trunc(req);
      r.state = back;
      if (back.session_id !== session || back.epoch !== state.epoch) {
        r.status = "UNVERIFIED";
        return [5, r];
      }
      r.status = action === "acquire" ? "ACQUIRED" : "RENEWED";
      return [0, r];
    });
  }
}
