// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Single-holder role lease: lock-serialized writes, verified by reading back under the same lock.
 *
 *   * freshness is judged against the stored expiry, not the duration a caller asks for;
 *   * a requested duration below minSeconds is raised to minSeconds;
 *   * every change of holder increments the epoch, so a former holder can be fenced off;
 *   * a different holder with an unexpired lease blocks acquire unless force is set.
 * Exit codes: 0 ok / 3 busy (another holder) / 4 not the holder, expired, or stale epoch / 5 write not verified.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withLock } from "./lock.js";
import { dumps } from "./pyjson.js";
import { atomicWrite, isPlainObject } from "./util.js";

export type LeaseAction = "status" | "acquire" | "renew" | "release";
export const LEASE_ACTIONS: LeaseAction[] = ["status", "acquire", "renew", "release"];

export interface LeaseRunOptions {
  leaseSeconds?: number | null;
  force?: boolean;
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

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export class Lease {
  readonly lock: string;
  constructor(readonly path: string, readonly defaultSeconds = 3600, readonly minSeconds = 60) {
    this.lock = path + ".lock.d";
  }

  load(): Record<string, any> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e: any) {
      if (e && e.code === "ENOENT") return {};
      throw e; // unreadable (permissions, a directory, I/O): fail closed, never read as FREE
    }
    try {
      const v = JSON.parse(text);
      return isPlainObject(v) ? v : {};
    } catch {
      return {}; // corrupt JSON reads as free, like v1.1
    }
  }

  private store(state: Record<string, any>): void {
    atomicWrite(this.path, dumps(state), { fsync: true, mode: 0o600, tmpSuffix: ".tmp" });
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
    mkdirSync(dirname(this.path), { recursive: true });
    const req = opts.leaseSeconds === undefined || opts.leaseSeconds === null ? this.defaultSeconds : opts.leaseSeconds;
    return withLock(this.lock, () => {
      const now = opts.now === undefined || opts.now === null ? Date.now() / 1000 : opts.now;
      let state = this.load();
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
        this.store(state);
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
          const prevEpoch = Number(state.epoch || 0);
          const history = holderHistory(state);
          state = { acquired_at: now, previous_owner: owner ?? null, epoch: Math.trunc(prevEpoch) + 1, state: "ACTIVE" };
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
      this.store(state);
      const back = this.load(); // same lock still held
      r.lease_seconds_raised = effective !== Math.trunc(req);
      r.state = back;
      if (back.session_id !== session) {
        r.status = "UNVERIFIED";
        return [5, r];
      }
      r.status = action === "acquire" ? "ACQUIRED" : "RENEWED";
      return [0, r];
    });
  }
}
