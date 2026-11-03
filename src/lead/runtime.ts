// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Short-lived lead loop. Cursor and receipt commit together; no external actions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Lease } from "../lease.js";
import { withLock } from "../lock.js";
import { Messages, type Message } from "../messages.js";
import { atomicWrite, isPlainObject, validName } from "../util.js";

interface Receipt {
  action: "boot" | "tick";
  status: "READY" | "PROCESSED" | "IDLE" | "DUPLICATE";
  session: string;
  epoch: number;
  previous_session: string | null;
  boot_count: number;
  event_cursor: number;
  last_tick: number;
  events: Pick<Message, "id" | "seq" | "kind" | "from">[];
  capabilities: { scheduler: "UNAVAILABLE"; wake: "UNAVAILABLE"; memory: "UNAVAILABLE" };
  decision: { status: "BLOCKED"; reason: string };
}

interface State {
  version: 1;
  message_path: string;
  event_cursor: number;
  last_tick: number;
  boot_count: number;
  receipt: Receipt | null;
}

export interface LoopOptions {
  session: string;
  seconds?: number;
  expectedEpoch?: number;
  tick?: number;
  approved?: boolean;
}

const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => counter(v) && v > 0;
// Never evict a live transaction just because it was descheduled for a minute.
const LOCK_OPTIONS = { protectLive: true };
const keys = (v: Record<string, any>, names: string[]) => Object.keys(v).sort().join(",") === names.sort().join(",");
const DISPATCH_REASON = "task dispatch is unavailable in this slice";

function validReceipt(v: any, state: State): boolean {
  if (v === null) return state.boot_count === 0 && state.last_tick === 0 && state.event_cursor === 0;
  if (!isPlainObject(v) || !keys(v, ["action", "status", "session", "epoch", "previous_session", "boot_count",
    "event_cursor", "last_tick", "events", "capabilities", "decision"]) || !validName(v.session) || !positive(v.epoch)
    || !(v.previous_session === null || validName(v.previous_session)) || !positive(v.boot_count)
    || v.event_cursor !== state.event_cursor || v.last_tick !== state.last_tick || v.boot_count !== state.boot_count
    || !Array.isArray(v.events) || v.events.length > 100) return false;
  if (v.action === "boot" ? v.status !== "READY" || v.events.length !== 0
    : v.action !== "tick" || !["PROCESSED", "IDLE"].includes(v.status)
      || !positive(v.last_tick) || (v.status === "PROCESSED") !== (v.events.length > 0)) return false;
  if (!isPlainObject(v.capabilities) || !keys(v.capabilities, ["scheduler", "wake", "memory"])
    || Object.values(v.capabilities).some((status) => status !== "UNAVAILABLE")
    || !isPlainObject(v.decision) || !keys(v.decision, ["status", "reason"])
    || v.decision.status !== "BLOCKED" || v.decision.reason !== DISPATCH_REASON) return false;
  let seq = 0;
  for (const e of v.events) {
    if (!isPlainObject(e) || !keys(e, ["id", "seq", "kind", "from"]) || typeof e.id !== "string" || !e.id
      || typeof e.from !== "string" || !["QUESTION", "ANSWER", "DONE", "BLOCKED"].includes(e.kind)
      || !positive(e.seq) || e.seq <= seq || e.seq > state.event_cursor) return false;
    seq = e.seq;
  }
  return true;
}

export class LeadLoop {
  readonly path: string;
  constructor(readonly lease: Lease, readonly messages: Messages) {
    this.path = lease.path + ".lead.json";
  }

  private load(): State {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      return { version: 1, message_path: resolve(this.messages.path), event_cursor: 0, last_tick: 0, boot_count: 0, receipt: null };
    }
    let v: any;
    try { v = JSON.parse(text); } catch { throw new Error("lead state is corrupt; reconcile before boot"); }
    if (!isPlainObject(v) || v.version !== 1 || typeof v.message_path !== "string"
      || !counter(v.event_cursor) || !counter(v.last_tick) || !counter(v.boot_count)
      || !keys(v, ["version", "message_path", "event_cursor", "last_tick", "boot_count", "receipt"])
      || !validReceipt(v.receipt, v as unknown as State)) {
      throw new Error("lead state is corrupt; reconcile before boot");
    }
    if (v.message_path !== resolve(this.messages.path)) throw new Error("lead message path changed; reconcile the event cursor");
    return v as State;
  }

  run(action: "boot" | "tick", opts: LoopOptions): [number, Record<string, any>] {
    if (!validName(opts.session)) throw new Error("--session is required; use a unique session name");
    if (opts.seconds !== undefined && !positive(opts.seconds)) throw new Error("--seconds must be a positive safe integer");
    if (action === "tick" && (!opts.approved || !positive(opts.expectedEpoch) || !positive(opts.tick))) {
      throw new Error("tick requires --approved, --expected-epoch and a positive safe integer --tick");
    }
    return withLock(this.lease.path + ".lead.lock.d", () => {
      const state = this.load();
      if (action === "boot" && state.boot_count === Number.MAX_SAFE_INTEGER) throw new Error("boot counter exhausted");
      if (action === "tick" && state.boot_count === 0) throw new Error("lead boot is required before tick");
      // The legacy lease reader treats corrupt JSON as free. Boot must not reset ownership.
      let stored: any = {};
      try { stored = JSON.parse(readFileSync(this.lease.path, "utf8")); }
      catch (e: any) { if (e.code !== "ENOENT") throw new Error("lead lease is unreadable or corrupt"); }
      if (!isPlainObject(stored) || (Object.keys(stored).length > 0
        && (!validName(stored.session_id) || !positive(stored.epoch)
          || !Number.isFinite(stored.lease_expires_at)))) throw new Error("lead lease is corrupt");
      const renew = action === "tick" || (stored.session_id === opts.session
        && stored.state === "ACTIVE" && stored.lease_expires_at > Date.now() / 1000);
      const [code, result] = this.lease.run(renew ? "renew" : "acquire", opts.session, {
        leaseSeconds: opts.seconds, expectedEpoch: action === "tick" ? opts.expectedEpoch : stored.epoch,
        lockOptions: LOCK_OPTIONS,
      });
      if (code !== 0) return [code, result];
      const epoch = result.state.epoch;
      // Lease.run released its lock. Recheck and hold it through the cursor commit.
      return withLock(this.lease.lock, () => {
        const held = this.lease.load();
        if (held.session_id !== opts.session || held.epoch !== epoch || held.state !== "ACTIVE"
          || held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
        if (state.event_cursor > 0
          && this.messages.all().reduce((max, m) => Math.max(max, m.seq), 0) < state.event_cursor) {
          throw new Error("message log is behind the event cursor; reconcile before continuing");
        }
        const duplicate = action === "tick" && opts.tick! <= state.last_tick;
        const events = action === "tick" && !duplicate
          ? this.messages.inbox("lead").filter((m) => m.seq > state.event_cursor).slice(0, 100)
            .map(({ id, seq, kind, from }) => ({ id, seq, kind, from })) : [];
        const previous = state.receipt?.session ?? null;
        if (action === "boot") state.boot_count++;
        if (action === "tick" && !duplicate) state.last_tick = opts.tick!;
        if (events.length) state.event_cursor = events[events.length - 1].seq;
        const receipt: Receipt = {
          action, status: action === "boot" ? "READY" : duplicate ? "DUPLICATE" : events.length ? "PROCESSED" : "IDLE",
          session: opts.session, epoch, previous_session: previous,
          boot_count: state.boot_count, event_cursor: state.event_cursor, last_tick: state.last_tick, events,
          capabilities: { scheduler: "UNAVAILABLE", wake: "UNAVAILABLE", memory: "UNAVAILABLE" },
          decision: { status: "BLOCKED", reason: DISPATCH_REASON },
        };
        if (!duplicate) {
          if (!counter(state.event_cursor) || !validReceipt(receipt, state)) throw new Error("invalid event metadata; reconcile the message log");
          if (held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
          state.receipt = receipt;
          atomicWrite(this.path, JSON.stringify(state) + "\n", { fsync: true, mode: 0o600 });
        }
        return [0, receipt];
      }, LOCK_OPTIONS);
    }, LOCK_OPTIONS);
  }
}
