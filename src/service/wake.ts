// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lock.js";
import { Messages } from "../messages.js";
import { renameRetry } from "../util.js";
import type { Runner } from "./scheduler.js";

export function snapshot(path: string, data: string): void {
  const tmp = path + ".tmp-" + randomUUID(), fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameRetry(tmp, path); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

export type Worker = { name: string; run: string; state: string };
export function workerSnapshot(root: string, platform: NodeJS.Platform, runner: Runner): Worker[] {
  if (!existsSync(root)) return [];
  const workers = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    const p = join(root, e.name, "worker.json");
    if (!existsSync(p)) return [];
    const m = JSON.parse(readFileSync(p, "utf8"));
    return Number.isInteger(m.pid) && m.pid > 0 && Number.isFinite(m.started_at) ? [{ name: e.name, ...m }] : [];
  });
  if (!workers.length) return [];
  const r = platform === "win32"
    ? runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @((Get-Process -ErrorAction Stop).Id) -Compress"])
    : runner("ps", ["-A", "-o", "pid=,pgid=,stat=,lstart="]);
  if (r.code !== 0) throw new Error(`worker probe failed: ${r.err}`);
  const starts = new Map<string, string>();
  const active = platform === "win32" ? new Set<number>(JSON.parse(r.out)) : new Set(r.out.split("\n").flatMap((l) => {
    const [pid, group, state, ...start] = l.trim().split(/\s+/);
    starts.set(pid, start.join(" "));
    return state && !state.startsWith("Z") ? [Number(pid), Number(group)] : [];
  }));
  return workers.map((m) => ({ name: m.name, run: `${m.pid}:${m.started_at}`, state: active.has(m.pid) && !(m.proc_start && starts.has(String(m.pid)) && starts.get(String(m.pid)) !== m.proc_start.replace(/\s+/g, " ").trim()) ? "RUNNING" : "STOPPED" }));
}

/** The cursor belongs to this log, so watching never acknowledges the lead's inbox. */
export class WakeWatch {
  constructor(readonly home: string, readonly messages: Messages, readonly reader: string, readonly workers: () => Worker[], readonly write = snapshot) {}
  tick(health?: Record<string, unknown>): number {
    const dir = join(this.home, "wake");
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("symbolic wake directory refused");
    mkdirSync(dir, { recursive: true });
    return withLock(join(dir, "watch.lock"), () => {
      const owner = join(dir, "owner.json"), log = join(dir, "events.log"), cursor = join(dir, "cursor.json");
      for (const p of [owner, log, cursor, join(dir, "health.json")]) try {
        if (lstatSync(p).isSymbolicLink()) throw new Error("symbolic wake file refused");
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const identity = JSON.stringify({ owner: "orch-wake-v1", home: this.home, reader: this.reader.toLowerCase() });
      if (!existsSync(owner)) {
        if (existsSync(log) || existsSync(cursor) || existsSync(join(dir, "health.json"))) throw new Error("unowned wake files; preserve them before enabling wake-watch");
        writeFileSync(owner, identity, { flag: "wx", mode: 0o600 });
      }
      if (readFileSync(owner, "utf8") !== identity) throw new Error("wake ownership or reader changed");
      const c = existsSync(cursor) ? JSON.parse(readFileSync(cursor, "utf8")) : { seq: 0 };
      if (!Number.isSafeInteger(c.seq) || c.seq < 0) throw new Error("invalid wake cursor");
      if ((c.deadman_period !== undefined && (!Number.isSafeInteger(c.deadman_period) || c.deadman_period < 0)) ||
        (c.deadman != null && (!Number.isSafeInteger(c.deadman) || c.deadman < 1 || c.deadman !== c.deadman_period))) throw new Error("invalid deadman cursor");
      const seen = new Set<string>();
      const prior = existsSync(log) ? readFileSync(log, "utf8") : "";
      for (const l of prior.split("\n").filter(Boolean)) {
        const event = JSON.parse(l);
        if (typeof event.id !== "string") throw new Error("invalid wake event log");
        seen.add(event.id);
      }
      const events: Record<string, unknown>[] = [];
      if (health) {
        const p = join(dir, "health.json");
        if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).owner !== "orch-health-v1") throw new Error("unowned health record");
        if (health.stale) {
          const period = c.deadman ?? (c.deadman_period ?? 0) + 1;
          c.deadman = period; c.deadman_period = period;
          events.push({ id: `deadman:${this.reader}:${period}`, kind: "DEADMAN", ...health });
        } else c.deadman = null;
      }
      const inbox = this.messages.inbox(this.reader);
      for (const m of inbox) if (m.seq > c.seq && ["QUESTION", "BLOCKED", "DONE"].includes(m.kind))
        events.push({ ...m, id: `message:${m.id}` });
      for (const w of this.workers()) if (w.state === "STOPPED")
        events.push({ id: `worker:${w.name}:${w.run}`, kind: "WORKER_EXIT", worker: w.name, run: w.run, ts: new Date().toISOString() });
      const fresh = events.filter((e) => !seen.has(String(e.id)));
      // Commit complete log snapshots before the cursor; event ids cover interruption between commits.
      if (fresh.length || !existsSync(log)) this.write(log, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + fresh.map((e) => JSON.stringify(e) + "\n").join(""));
      this.write(cursor, JSON.stringify({ ...c, seq: inbox.reduce((seq, m) => Math.max(seq, m.seq), c.seq) }));
      if (health) this.write(join(dir, "health.json"), JSON.stringify({ owner: "orch-health-v1", ...health }));
      return fresh.length;
    });
  }
}
