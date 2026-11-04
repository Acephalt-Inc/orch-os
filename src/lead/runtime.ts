// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Short-lived lead loop with one approved, fenced task dispatch. */
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../config.js";
import { Lease } from "../lease.js";
import { withLock } from "../lock.js";
import { Messages, type Message } from "../messages.js";
import { readProfile } from "../profile.js";
import { Tasks } from "../tasks.js";
import { groupAlive, Workers } from "../workers.js";
import { atomicWrite, isPlainObject, validName, which } from "../util.js";

class ReservationError extends Error {}

interface TaskInput { id: string; brief: string; command: string[]; workdir: string; timeout_seconds: number }
interface Reservation {
  version: 1; id: string; nonce: string; phase: "RESERVED" | "CLAIMED" | "RELEASED";
  proof?: { pid: number; process_group: "inherited"; completion: Completion; seq: number };
  task: TaskInput; timeout_bin: string; holder: string; claim_epoch: number | null;
  task_dir: string; worker_root: string; message_path: string; lease_path: string; lead_session: string; lead_epoch: number;
}
interface Completion { id: string; task: string; status: "EXITED" | "SIGNALED"; exit_code: number | null; signal: string | null; event_id: string }

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
  completion?: Completion;
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
const SLOT_REASON = "task slot occupied; after the process group stops, run an approved increasing tick; preserve uncertain evidence for manual review (docs/lead-runtime.md)";
const AVAILABLE_REASON = "a separate approved dispatch is required for another task";

function validReceipt(v: any, state: State): boolean {
  if (v === null) return state.boot_count === 0 && state.last_tick === 0 && state.event_cursor === 0;
  if (!isPlainObject(v) || !keys(v, ["action", "status", "session", "epoch", "previous_session", "boot_count",
    "event_cursor", "last_tick", "events", "capabilities", "decision", ...(v.completion === undefined ? [] : ["completion"])]) || !validName(v.session) || !positive(v.epoch)
    || !(v.previous_session === null || validName(v.previous_session)) || !positive(v.boot_count)
    || v.event_cursor !== state.event_cursor || v.last_tick !== state.last_tick || v.boot_count !== state.boot_count
    || !Array.isArray(v.events) || v.events.length > 100) return false;
  if (v.action === "boot" ? v.status !== "READY" || v.events.length !== 0
    : v.action !== "tick" || !["PROCESSED", "IDLE"].includes(v.status)
      || !positive(v.last_tick) || (v.status === "PROCESSED") !== (v.events.length > 0)) return false;
  if (!isPlainObject(v.capabilities) || !keys(v.capabilities, ["scheduler", "wake", "memory"])
    || Object.values(v.capabilities).some((status) => status !== "UNAVAILABLE")
    || !isPlainObject(v.decision) || !keys(v.decision, ["status", "reason"])
    || v.decision.status !== "BLOCKED" || ![DISPATCH_REASON, SLOT_REASON, AVAILABLE_REASON,
      "one approved task slot is occupied; no further dispatch is available"].includes(v.decision.reason)) return false;
  if (v.completion !== undefined && (v.action !== "tick" || !isPlainObject(v.completion)
    || !keys(v.completion, ["id", "task", "status", "exit_code", "signal", "event_id"])
    || !validName(v.completion.id) || !validName(v.completion.task) || !validName(v.completion.event_id)
    || !["EXITED", "SIGNALED"].includes(v.completion.status)
    || !(v.completion.exit_code === null || (counter(v.completion.exit_code) && v.completion.exit_code <= 255))
    || !(v.completion.signal === null || Object.hasOwn(osConstants.signals, v.completion.signal))
    || (v.completion.exit_code === null) === (v.completion.signal === null)
    || (v.completion.status === "EXITED") !== (v.completion.exit_code !== null)
    || !v.events.some((e: any) => e.id === v.completion.event_id && e.kind === "DONE" && e.from === "lead-supervisor"))) return false;
  let seq = 0;
  for (const e of v.events) {
    if (!isPlainObject(e) || !keys(e, ["id", "seq", "kind", "from"]) || typeof e.id !== "string" || !e.id
      || typeof e.from !== "string" || !["QUESTION", "ANSWER", "DONE", "BLOCKED"].includes(e.kind)
      || !positive(e.seq) || e.seq <= seq || e.seq > state.event_cursor) return false;
    seq = e.seq;
  }
  return true;
}

export interface TimeoutAdapter {
  platform: NodeJS.Platform;
  find(name: string): string | null;
  probe(command: string, args: string[]): { status: number | null; signal?: string | null; error?: unknown };
}
const TIMEOUT_ADAPTER: TimeoutAdapter = {
  platform: process.platform, find: which,
  probe: (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 6000, killSignal: "SIGKILL" }),
};

export class LeadLoop {
  readonly path: string;
  readonly taskPath: string;
  constructor(readonly lease: Lease, readonly messages: Messages, readonly cfg: Record<string, any> = {},
    readonly timeout: TimeoutAdapter = TIMEOUT_ADAPTER, readonly groupProbe: (pid: number) => boolean = groupAlive) {
    this.path = resolve(lease.path) + ".lead.json";
    this.taskPath = resolve(lease.path) + ".lead-task.json";
  }

  private bindings() {
    return { task_dir: resolve(C.expand(this.cfg.tasks?.dir ?? `${C.orchHome()}/tasks`)),
      worker_root: resolve(C.expand(this.cfg.workers?.root ?? `${C.orchHome()}/workers`)), message_path: resolve(this.messages.path),
      lease_path: resolve(this.lease.path) };
  }

  private reservation(): Reservation | null {
    if (!existsSync(this.taskPath)) return null;
    let v: any;
    try { v = JSON.parse(readFileSync(this.taskPath, "utf8")); } catch { throw new ReservationError("lead task reservation is corrupt; reconcile manually"); }
    if (!isPlainObject(v) || !keys(v, ["version", "id", "nonce", "phase", "task", "timeout_bin", "holder", "claim_epoch", "task_dir", "worker_root", "message_path", "lease_path", "lead_session", "lead_epoch", ...(v.proof === undefined ? [] : ["proof"])])
      || v.version !== 1 || !validName(v.id) || !validName(v.nonce) || !validName(v.holder) || !validName(v.lead_session) || !positive(v.lead_epoch)
      || !["RESERVED", "CLAIMED", "RELEASED"].includes(v.phase) || !(v.claim_epoch === null || positive(v.claim_epoch))
      || (v.phase === "RESERVED") !== (v.claim_epoch === null)
      || (v.phase === "RELEASED" ? !isPlainObject(v.proof) || !keys(v.proof, ["pid", "process_group", "completion", "seq"])
        || !positive(v.proof.pid) || v.proof.process_group !== "inherited" || !positive(v.proof.seq) || !isPlainObject(v.proof.completion)
        || !keys(v.proof.completion, ["id", "task", "status", "exit_code", "signal", "event_id"])
        || v.proof.completion.id !== v.id || v.proof.completion.task !== v.task?.id
        || v.proof.completion.event_id !== `lead-completion-${v.nonce}`
        || !["EXITED", "SIGNALED"].includes(v.proof.completion.status)
        || !(v.proof.completion.exit_code === null || (counter(v.proof.completion.exit_code) && v.proof.completion.exit_code <= 255))
        || !(v.proof.completion.signal === null || Object.hasOwn(osConstants.signals, v.proof.completion.signal))
        || (v.proof.completion.exit_code === null) === (v.proof.completion.signal === null)
        || (v.proof.completion.status === "EXITED") !== (v.proof.completion.exit_code !== null) : v.proof !== undefined)
      || typeof v.timeout_bin !== "string"
      || Object.entries(this.bindings()).some(([k, path]) => v[k] !== path)
      || !this.validTask(v.task, false)) throw new ReservationError("lead task reservation is corrupt or configuration changed; reconcile manually");
    return v as Reservation;
  }

  private validTask(v: any, checkDir = true): v is TaskInput {
    if (!isPlainObject(v) || !keys(v, ["id", "brief", "command", "workdir", "timeout_seconds"])
      || !validName(v.id) || typeof v.brief !== "string" || !Array.isArray(v.command) || !v.command.length
      || v.command.some((a: unknown) => typeof a !== "string" || !a)
      || typeof v.workdir !== "string" || !v.workdir || !positive(v.timeout_seconds) || v.timeout_seconds > 86400) return false;
    if (!checkDir) return true;
    try { return statSync(v.workdir).isDirectory(); } catch { return false; }
  }

  dispatch(opts: LoopOptions & { taskFile: string }): [number, Record<string, any>] {
    if (!validName(opts.session) || !opts.approved || !positive(opts.expectedEpoch) || !opts.taskFile) throw new Error("dispatch requires --session, --expected-epoch, --approved and --task-file");
    let task: any;
    try { task = JSON.parse(readFileSync(opts.taskFile, "utf8")); } catch { throw new Error("task file is unreadable or invalid JSON"); }
    if (!this.validTask(task)) throw new Error("task must have id, brief, nonempty command argv, directory workdir and timeout_seconds 1..86400");
    task.workdir = resolve(task.workdir);
    return withLock(this.lease.path + ".lead.lock.d", () => {
      const state = this.load();
      if (!state.boot_count) throw new Error("lead boot is required before dispatch");
      return withLock(this.lease.lock, () => {
        const held = this.lease.load();
        if (held.session_id !== opts.session || held.epoch !== opts.expectedEpoch || held.state !== "ACTIVE"
          || held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
        let prior: Reservation | null;
        try {
          prior = this.reservation();
          if (prior && !this.releaseConsumed(prior, state)) return [3, { status: "BLOCKED", reason: SLOT_REASON }];
        } catch (e) {
          if (!(e instanceof ReservationError)) throw e;
          return [3, { status: "BLOCKED", reason: `${e.message}; see docs/lead-runtime.md` }];
        }
        if (prior) {
          // The released tombstone remains until the next reservation is ready to replace it.
          if (this.timeout.platform === "win32") return [2, { status: "UNAVAILABLE",
            reason: "task dispatch requires POSIX process control; no Windows adapter is available" }];
        } else if (existsSync(this.taskPath + ".gate") || existsSync(this.taskPath + ".exit")) {
          return [3, { status: "BLOCKED", reason: "orphaned launch evidence; reconcile manually" }];
        }
        if (this.timeout.platform === "win32") return [2, { status: "UNAVAILABLE",
          reason: "task dispatch requires POSIX process control; no Windows adapter is available" }];
        // Require a KILL exit from timeout around a TERM-resistant child, without vendor banners.
        // Its own four-second exit bounds the probe even if a program ignores the flags.
        const probeScript = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(42),4000)";
        const timeoutBin = ["timeout", "gtimeout"].map((name) => this.timeout.find(name)).find((bin) => {
          if (!bin) return false;
          const result = this.timeout.probe(bin, ["--foreground", "--kill-after=1s", "1s", process.execPath, "-e", probeScript]);
          return !result.error && (result.status === 137 || result.signal === "SIGKILL");
        });
        if (held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
        if (!timeoutBin) return [2, { status: "UNAVAILABLE", reason: "timeout with --kill-after support is required" }];
        if (prior) {
          // Both files were verified against the released invocation. Never let a new gate
          // inherit evidence from the previous invocation.
          for (const suffix of [".gate", ".exit"]) if (existsSync(this.taskPath + suffix)) unlinkSync(this.taskPath + suffix);
        }
        const b = this.bindings();
        const id = randomUUID(), nonce = randomUUID(), holder = `lead-${nonce}`;
        const reservation: Reservation = { version: 1, id, nonce, phase: "RESERVED", task,
          timeout_bin: timeoutBin, holder, claim_epoch: null, lead_session: opts.session, lead_epoch: opts.expectedEpoch!, ...b };
        atomicWrite(this.taskPath, JSON.stringify(reservation) + "\n", { fsync: true, mode: 0o600 });
        const tasks = new Tasks(b.task_dir, C.configNumber(this.cfg.tasks?.default_seconds, 7200, "[tasks] default_seconds", 1),
          C.configNumber(this.cfg.tasks?.min_seconds, 60, "[tasks] min_seconds", 1));
        const [claimCode, claim] = tasks.claim(task.id, holder, { seconds: task.timeout_seconds + 120 });
        if (claimCode !== 0) return [claimCode, { status: "BLOCKED", reason: "task claim unavailable; reservation retained" }];
        reservation.phase = "CLAIMED"; reservation.claim_epoch = claim.state.epoch;
        atomicWrite(this.taskPath, JSON.stringify(reservation) + "\n", { fsync: true, mode: 0o600 });
        const workers = new Workers(this.cfg, b.worker_root, C.expand(this.cfg.load?.state ?? `${C.orchHome()}/load.json`));
        const limit = readProfile(this.cfg)?.max_workers ?? null;
        const supervisor = fileURLToPath(new URL("./supervisor.js", import.meta.url));
        try {
          const worker = workers.start(`lead-${nonce}`, { command: [process.execPath, supervisor, Buffer.from(this.taskPath).toString("base64url"), nonce],
            task: opts.taskFile, workdir: task.workdir, minutes: 0, limit,
            beforeSpawn: () => {
              const h = this.lease.load(), [code, claimNow] = tasks.status(task.id);
              if (h.session_id !== opts.session || h.epoch !== opts.expectedEpoch || h.state !== "ACTIVE"
                || h.lease_expires_at <= Date.now() / 1000 || code !== 0 || claimNow.state.session_id !== holder
                || claimNow.state.epoch !== reservation.claim_epoch || claimNow.status !== "HELD") throw new Error("lead lease or task claim expired before launch");
            } });
          return [0, { status: "DISPATCHED", id, task: task.id, worker: worker.name, pid: worker.pid }];
        } catch (e: any) { return [2, { status: "BLOCKED", reason: e.message ?? "launch uncertain; reservation retained" }]; }
      }, LOCK_OPTIONS);
    }, LOCK_OPTIONS);
  }

  private completionEvidence(reservation: Reservation): { completion: Completion; pid: number; verifiable: boolean } | undefined {
    if (!existsSync(this.taskPath + ".exit")) return undefined;
    let gate: any, exit: any;
    try {
      gate = JSON.parse(readFileSync(this.taskPath + ".gate", "utf8"));
      exit = JSON.parse(readFileSync(this.taskPath + ".exit", "utf8"));
    } catch { throw new ReservationError("lead task launch or exit evidence is corrupt; reconcile manually"); }
    const identity = (e: any) => isPlainObject(e) && keys(e, ["id", "nonce", "task", "pid",
      ...(e.process_group === undefined ? [] : ["process_group"]), ...(e.error === undefined ? [] : ["exit_code", "signal", "error"])])
      && e.id === reservation.id && e.nonce === reservation.nonce && e.task === reservation.task.id
      && positive(e.pid) && (e.process_group === undefined || e.process_group === "inherited");
    if (!identity(gate) || !identity(exit) || gate.pid !== exit.pid || gate.process_group !== exit.process_group
      || !keys(exit, ["id", "nonce", "task", "pid", "exit_code", "signal", "error",
        ...(exit.process_group === undefined ? [] : ["process_group"])])
      || !(exit.exit_code === null || (counter(exit.exit_code) && exit.exit_code <= 255))
      || !(exit.signal === null || Object.hasOwn(osConstants.signals, exit.signal))
      || (exit.exit_code === null) === (exit.signal === null)
      || exit.error !== null) throw new ReservationError("lead task exit evidence mismatches reservation; reconcile manually");
    const status: Completion["status"] = exit.signal ? "SIGNALED" : "EXITED";
    const completion: Completion = { id: reservation.id, task: reservation.task.id, status,
      exit_code: exit.exit_code, signal: exit.signal, event_id: `lead-completion-${reservation.nonce}` };
    return { completion, pid: gate.pid, verifiable: gate.process_group === "inherited" };
  }

  private reconcile(reservation: Reservation | null): Completion | undefined {
    if (!reservation || reservation.phase !== "CLAIMED") return undefined;
    const evidence = this.completionEvidence(reservation);
    if (!evidence) return undefined;
    const { completion } = evidence;
    this.messages.send("lead-supervisor", "lead", "DONE", JSON.stringify(completion), null, undefined, completion.event_id);
    return completion;
  }

  /** Recover the cursor-to-tombstone gap, or verify an existing tombstone. */
  private releaseConsumed(reservation: Reservation, state: State): boolean {
    if (reservation.phase === "RESERVED") return false;
    if (this.timeout.platform === "win32") return false;
    const evidence = reservation.phase === "CLAIMED" ? this.completionEvidence(reservation) : undefined;
    if (reservation.phase === "CLAIMED" && (!evidence || !evidence.verifiable)) return false;
    const { completion, pid } = evidence ?? reservation.proof!;
    if (reservation.phase === "RELEASED") {
      // Sidecars may have been removed before a crash. Check each remaining file
      // against the durable proof before deleting it or reusing the paths.
      for (const suffix of [".gate", ".exit"]) {
        if (!existsSync(this.taskPath + suffix)) continue;
        let sidecar: any;
        try { sidecar = JSON.parse(readFileSync(this.taskPath + suffix, "utf8")); }
        catch { throw new ReservationError("released task sidecar is corrupt; reconcile manually"); }
        if (!isPlainObject(sidecar) || !keys(sidecar, ["id", "nonce", "task", "pid", "process_group",
          ...(suffix === ".exit" ? ["exit_code", "signal", "error"] : [])])
          || sidecar.id !== reservation.id || sidecar.nonce !== reservation.nonce
          || sidecar.task !== reservation.task.id || sidecar.pid !== pid || sidecar.process_group !== "inherited")
          throw new ReservationError("released task sidecar mismatches proof; reconcile manually");
        if (suffix === ".exit" && (sidecar.exit_code !== completion.exit_code || sidecar.signal !== completion.signal
          || sidecar.error !== null)) throw new ReservationError("released task exit mismatches proof; reconcile manually");
      }
    }
    const matches = this.messages.all().filter((m) => m.id === completion.event_id);
    if (matches.length !== 1 || !positive(matches[0].seq) || matches[0].seq > state.event_cursor || matches[0].from !== "lead-supervisor"
      || matches[0].to !== "lead" || matches[0].kind !== "DONE" || matches[0].reply_to !== null
      || matches[0].body !== JSON.stringify(completion)) {
      if (reservation.phase === "RELEASED") throw new ReservationError("released task completion is not durably consumed; reconcile manually");
      return false;
    }
    if (reservation.phase === "RELEASED" && reservation.proof!.seq !== matches[0].seq)
      throw new ReservationError("released task completion sequence changed; reconcile manually");
    if (this.groupProbe(pid)) return false;
    if (reservation.phase === "CLAIMED") {
      const tasks = new Tasks(reservation.task_dir);
      const [code, claim] = tasks.status(reservation.task.id);
      if (code !== 0 || claim.state.session_id !== reservation.holder || claim.state.epoch !== reservation.claim_epoch)
        throw new ReservationError("matching task claim changed; reconcile manually");
      if (claim.state.state === "ACTIVE") {
        if (tasks.release(reservation.task.id, reservation.holder, { expectedEpoch: reservation.claim_epoch! })[0] !== 0)
          throw new ReservationError("matching task claim could not be released; reconcile manually");
      } else if (claim.state.state !== "RELEASED") throw new ReservationError("matching task claim is not released; reconcile manually");
      reservation.phase = "RELEASED";
      reservation.proof = { pid, process_group: "inherited", completion, seq: matches[0].seq };
      atomicWrite(this.taskPath, JSON.stringify(reservation) + "\n", { fsync: true, mode: 0o600 });
    }
    return true;
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
        const reservation = this.reservation();
        const verified = action === "tick" && !duplicate ? this.reconcile(reservation) : undefined;
        const events = action === "tick" && !duplicate
          ? this.messages.inbox("lead").filter((m) => m.seq > state.event_cursor).slice(0, 100)
            .map(({ id, seq, kind, from }) => ({ id, seq, kind, from })) : [];
        const completion = verified && events.some((e) => e.id === verified.event_id) ? verified : undefined;
        const previous = state.receipt?.session ?? null;
        if (action === "boot") state.boot_count++;
        if (action === "tick" && !duplicate) state.last_tick = opts.tick!;
        if (events.length) state.event_cursor = events[events.length - 1].seq;
        const receipt: Receipt = {
          action, status: action === "boot" ? "READY" : duplicate ? "DUPLICATE" : events.length ? "PROCESSED" : "IDLE",
          session: opts.session, epoch, previous_session: previous,
          boot_count: state.boot_count, event_cursor: state.event_cursor, last_tick: state.last_tick, events,
          capabilities: { scheduler: "UNAVAILABLE", wake: "UNAVAILABLE", memory: "UNAVAILABLE" },
          decision: { status: "BLOCKED", reason: reservation?.phase === "RELEASED" ? AVAILABLE_REASON
            : reservation ? SLOT_REASON : AVAILABLE_REASON },
          ...(completion ? { completion } : {}),
        };
        if (!duplicate) {
          if (!counter(state.event_cursor) || !validReceipt(receipt, state)) throw new Error("invalid event metadata; reconcile the message log");
          if (held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
          if (completion && reservation && this.timeout.platform !== "win32") {
            const evidence = this.completionEvidence(reservation);
            if (!evidence || evidence.completion.event_id !== completion.event_id)
              throw new Error("task completion evidence changed; cursor was not committed");
            if (evidence.verifiable && !this.groupProbe(evidence.pid)) {
              const tasks = new Tasks(reservation.task_dir);
              const [code, claim] = tasks.status(reservation.task.id);
              if (code !== 0 || claim.state.session_id !== reservation.holder || claim.state.epoch !== reservation.claim_epoch
                || (claim.state.state === "ACTIVE"
                  ? tasks.release(reservation.task.id, reservation.holder, { expectedEpoch: reservation.claim_epoch! })[0] !== 0
                  : claim.state.state !== "RELEASED"))
                throw new Error("matching task claim could not be released; cursor was not committed");
              receipt.decision.reason = AVAILABLE_REASON;
            }
          }
          if (held.lease_expires_at <= Date.now() / 1000) return [4, { status: "STALE_LEASE" }];
          state.receipt = receipt;
          atomicWrite(this.path, JSON.stringify(state) + "\n", { fsync: true, mode: 0o600 });
        }
        if (action === "tick" && reservation && reservation.phase !== "RESERVED") this.releaseConsumed(reservation, state);
        return [0, receipt];
      }, LOCK_OPTIONS);
    }, LOCK_OPTIONS);
  }
}
