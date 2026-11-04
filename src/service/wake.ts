// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lock.js";
import { Messages } from "../messages.js";
import { renameRetry } from "../util.js";
import type { Runner } from "./scheduler.js";

function snapshot(path: string, data: string): void {
  const tmp = path + ".tmp-" + randomUUID(), fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameRetry(tmp, path); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

type Worker = { name: string; run: string; state: string };
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
  constructor(readonly home: string, readonly messages: Messages, readonly reader: string, readonly workers: () => Worker[]) {}
  tick(): number {
    const dir = join(this.home, "wake");
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("symbolic wake directory refused");
    mkdirSync(dir, { recursive: true });
    return withLock(join(dir, "watch.lock"), () => {
      const owner = join(dir, "owner.json"), log = join(dir, "events.log"), cursor = join(dir, "cursor.json");
      for (const p of [owner, log, cursor]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("symbolic wake file refused");
      const identity = JSON.stringify({ owner: "orch-wake-v1", home: this.home, reader: this.reader.toLowerCase() });
      if (!existsSync(owner)) {
        if (existsSync(log) || existsSync(cursor)) throw new Error("unowned wake files; preserve them before enabling wake-watch");
        writeFileSync(owner, identity, { flag: "wx", mode: 0o600 });
      }
      if (readFileSync(owner, "utf8") !== identity) throw new Error("wake ownership or reader changed");
      const c = existsSync(cursor) ? JSON.parse(readFileSync(cursor, "utf8")) : { seq: 0 };
      if (!Number.isSafeInteger(c.seq) || c.seq < 0) throw new Error("invalid wake cursor");
      const seen = new Set<string>();
      const prior = existsSync(log) ? readFileSync(log, "utf8") : "";
      for (const l of prior.split("\n").filter(Boolean)) {
        const event = JSON.parse(l);
        if (typeof event.id !== "string") throw new Error("invalid wake event log");
        seen.add(event.id);
      }
      const events: Record<string, unknown>[] = [];
      const inbox = this.messages.inbox(this.reader);
      for (const m of inbox) if (m.seq > c.seq && ["QUESTION", "BLOCKED", "DONE"].includes(m.kind))
        events.push({ ...m, id: `message:${m.id}` });
      for (const w of this.workers()) if (w.state === "STOPPED")
        events.push({ id: `worker:${w.name}:${w.run}`, kind: "WORKER_EXIT", worker: w.name, run: w.run, ts: new Date().toISOString() });
      const fresh = events.filter((e) => !seen.has(String(e.id)));
      // Commit complete log snapshots before the cursor; event ids cover interruption between commits.
      if (fresh.length || !existsSync(log)) snapshot(log, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + fresh.map((e) => JSON.stringify(e) + "\n").join(""));
      snapshot(cursor, JSON.stringify({ seq: inbox.reduce((seq, m) => Math.max(seq, m.seq), c.seq) }));
      return fresh.length;
    });
  }
}
