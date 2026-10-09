// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Daily unattended workers registered with the current user's operating-system scheduler. */
import { spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";

const MARK = "Managed by orch schedule";
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export type Result = { code: number; out: string; err: string };
export interface Host {
  platform: string; home: string; uid: number;
  node: string; cli: string; orchHome: string; envOrchHome?: string;
  run(tool: string, args: string[]): Result;
  exists(path: string): boolean; lstat(path: string): { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean };
  read(path: string): string; write(path: string, text: string): void; append(path: string, text: string): void;
  mkdir(path: string): void; remove(path: string): void; list(path: string): string[];
  managerAvailable?: () => boolean;
}
export interface ScheduleRecord { name: string; daily: string; task: string; agent: string | null; workdir: string; node: string; cli: string; orchHome?: string }
export interface ScheduleIO { out(s: string): void; err(s: string): void }
export interface Runtime {
  config(): Record<string, any>;
  sample(cfg: Record<string, any>): void;
  start(cfg: Record<string, any>, name: string, opts: Record<string, any>): Record<string, any>;
  limit(cfg: Record<string, any>): number | null;
}

function command(r: ScheduleRecord): string[] { return [r.node, r.cli, "schedule", "run", r.name]; }
function xml(s: string): string { return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function plist(r: ScheduleRecord): string {
  const [hour, minute] = r.daily.split(":").map(Number);
  const env = r.orchHome === undefined ? "" : `\n  <key>EnvironmentVariables</key><dict><key>ORCH_HOME</key><string>${xml(r.orchHome)}</string></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARK} -->\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.orch-os.schedule.${xml(r.name)}</string>\n  <key>ProgramArguments</key><array>${command(r).map((x) => `<string>${xml(x)}</string>`).join("")}</array>${env}\n  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>\n</dict></plist>\n`;
}
function sq(s: string): string { return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
function service(r: ScheduleRecord): string {
  const env = r.orchHome === undefined ? "" : `Environment=${sq(`ORCH_HOME=${r.orchHome}`)}\n`;
  return `# ${MARK}\n[Unit]\nDescription=orch scheduled worker ${r.name}\n[Service]\nType=oneshot\n${env}ExecStart=${command(r).map(sq).join(" ")}\n`;
}
function timer(r: ScheduleRecord): string { return `# ${MARK}\n[Unit]\nDescription=Daily orch worker ${r.name}\n[Timer]\nOnCalendar=*-*-* ${r.daily}:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n`; }
function paths(h: Host, name: string) {
  const base = posix.join(h.orchHome, "schedule");
  const launch = posix.join(h.home, "Library/LaunchAgents", `com.orch-os.schedule.${name}.plist`);
  const units = posix.join(h.home, ".config/systemd/user");
  return { base, record: posix.join(base, `${name}.json`), log: posix.join(base, `${name}.log`), launch,
    service: posix.join(units, `orch-os-schedule-${name}.service`), timer: posix.join(units, `orch-os-schedule-${name}.timer`) };
}
function backend(h: Host): "launchd" | "systemd" | null { return h.platform === "darwin" ? "launchd" : h.platform === "linux" ? "systemd" : null; }
function refusal(h: Host): string { return `schedule: no scheduler backend for ${h.platform} in this version; nothing was installed or changed`; }
function validRecord(v: any): v is ScheduleRecord {
  return v && typeof v === "object" && NAME.test(v.name) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.daily) &&
    typeof v.task === "string" && typeof v.workdir === "string" && typeof v.node === "string" && typeof v.cli === "string" &&
    (v.agent === null || typeof v.agent === "string") && (v.orchHome === undefined || typeof v.orchHome === "string");
}
function readRecord(h: Host, path: string): ScheduleRecord | null { try { const v = JSON.parse(h.read(path)); return validRecord(v) ? v : null; } catch { return null; } }
function owned(h: Host, path: string, shape?: string): boolean {
  try { const st = h.lstat(path); if (st.isSymbolicLink() || !st.isFile()) return false; const t = h.read(path); return t.includes(MARK) && (!shape || t.includes(shape)); } catch { return false; }
}
function writeAll(h: Host, files: [string, string][]): void { for (const [p] of files) h.mkdir(dirname(p)); for (const [p, t] of files) h.write(p, t); }
function fail(io: ScheduleIO, step: string, r: Result): number { io.err(`schedule: ${step} failed${r.err.trim() ? `: ${r.err.trim()}` : ""}\n`); return 1; }
function stateChanging(tool: string, args: string[]): boolean { return tool === "launchctl" || (tool === "systemctl" && ["daemon-reload", "enable", "disable"].some((x) => args.includes(x))); }

export function install(h: Host, io: ScheduleIO, a: any, cfg: Record<string, any>): number {
  const b = backend(h); if (!b) { io.err(refusal(h) + "\n"); return 2; }
  if (!NAME.test(a.name ?? "")) { io.err("schedule: NAME must match ^[a-z0-9][a-z0-9-]{0,31}$; nothing was installed or changed\n"); return 2; }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.daily ?? "")) { io.err("schedule: --daily must be HH:MM from 00:00 through 23:59; nothing was installed or changed\n"); return 2; }
  const task = resolve(String(a.task ?? ""));
  try { if (!h.lstat(task).isFile()) throw 0; } catch { io.err("schedule: task must be an existing regular file; nothing was installed or changed\n"); return 2; }
  const workdir = resolve(a.workdir ?? process.cwd());
  try { if (!h.lstat(workdir).isDirectory()) throw 0; } catch { io.err("schedule: workdir must be an existing directory; nothing was installed or changed\n"); return 2; }
  const agent = a.agent ?? null;
  if (agent ? !(agent in (cfg.agents ?? {})) : !Array.isArray(cfg.workers?.command) || !cfg.workers.command.length) {
    io.err("schedule: agent is not configured and [workers] command is empty; nothing was installed or changed\n"); return 2;
  }
  if (b === "systemd" && !(h.managerAvailable ? h.managerAvailable() : h.run("systemctl", ["--user", "show-environment"]).code === 0)) {
    io.err("schedule: systemctl --user did not answer; nothing was installed or changed\n"); return 2;
  }
  const r: ScheduleRecord = { name: a.name, daily: a.daily, task, agent, workdir, node: h.node, cli: h.cli, ...(h.envOrchHome === undefined ? {} : { orchHome: h.envOrchHome }) };
  const p = paths(h, r.name); const units: [string, string][] = b === "launchd" ? [[p.launch, plist(r)]] : [[p.service, service(r)], [p.timer, timer(r)]];
  for (const [path] of units) if (h.exists(path) && !owned(h, path, b === "systemd" && path === p.service ? "ExecStart=" : undefined)) {
    io.err(`schedule: ${path} is foreign or a symbolic link; nothing was installed or changed\n`); return 2;
  }
  const old = readRecord(h, p.record); const recText = JSON.stringify(r, null, 2) + "\n";
  if (old && h.read(p.record) === recText && units.every(([x, t]) => h.exists(x) && h.read(x) === t)) { io.out(`unchanged ${r.name}\n`); return 0; }
  if (a.dry_run) { for (const [x, t] of [...units, [p.record, recText] as [string, string]]) io.out(`--- ${x}\n${t}`); io.out(b === "launchd" ? `launchctl bootstrap gui/${h.uid} ${p.launch}\n` : `systemctl --user daemon-reload\nsystemctl --user enable --now ${posix.basename(p.timer)}\n`); return 0; }
  if (old) {
    const q = b === "launchd" ? h.run("launchctl", ["bootout", `gui/${h.uid}/com.orch-os.schedule.${r.name}`]) : h.run("systemctl", ["--user", "disable", "--now", posix.basename(p.timer)]);
    if (q.code !== 0 && !/not loaded|not found|not enabled/i.test(q.err + q.out)) return fail(io, b === "launchd" ? "bootout" : "disable", q);
  }
  writeAll(h, [...units, [p.record, recText]]);
  if (b === "launchd") { const q = h.run("launchctl", ["bootstrap", `gui/${h.uid}`, p.launch]); if (q.code) return fail(io, "bootstrap", q); }
  else { let q = h.run("systemctl", ["--user", "daemon-reload"]); if (q.code) return fail(io, "daemon-reload", q); q = h.run("systemctl", ["--user", "enable", "--now", posix.basename(p.timer)]); if (q.code) return fail(io, "enable --now", q); }
  io.out(`scheduled ${r.name} daily ${r.daily} (${b})\n`); return 0;
}

export function runScheduled(h: Host, io: ScheduleIO, name: string, rt: Runtime): number {
  if (!backend(h)) { io.err(refusal(h) + "\n"); return 2; }
  if (!NAME.test(name ?? "")) { io.err("schedule: invalid NAME\n"); return 2; }
  const p = paths(h, name), r = readRecord(h, p.record); if (!r || r.name !== name) { io.err(`schedule: unknown or invalid record ${name}\n`); return 2; }
  const cfg = rt.config(); rt.sample(cfg);
  try { const x = rt.start(cfg, `sched-${name}`, { agent: r.agent, task: r.task, workdir: r.workdir, limit: rt.limit(cfg) }); h.mkdir(dirname(p.log)); h.append(p.log, `${new Date().toISOString()} STARTED pid=${x.pid}\n`); return 0; }
  catch (e: any) { h.mkdir(dirname(p.log)); h.append(p.log, `${new Date().toISOString()} REFUSED ${e?.message ?? e}\n`); return 1; }
}

function names(h: Host): string[] {
  const found = new Set<string>(); const add = (dir: string, re: RegExp) => { for (const x of h.list(dir)) { const m = re.exec(x); if (m) found.add(m[1]); } };
  add(posix.join(h.orchHome, "schedule"), /^([a-z0-9][a-z0-9-]{0,31})\.json$/);
  if (h.platform === "darwin") add(posix.join(h.home, "Library/LaunchAgents"), /^com\.orch-os\.schedule\.([a-z0-9][a-z0-9-]{0,31})\.plist$/);
  if (h.platform === "linux") add(posix.join(h.home, ".config/systemd/user"), /^orch-os-schedule-([a-z0-9][a-z0-9-]{0,31})\.(?:service|timer)$/);
  return [...found].sort();
}
export function status(h: Host, io: ScheduleIO, json = false): number {
  if (!backend(h)) { io.err(refusal(h) + "\n"); return 2; } const ns = names(h); if (!ns.length) { io.out(json ? "[]\n" : "no scheduled jobs\n"); return 0; }
  const rows: any[] = []; for (const name of ns) { const p = paths(h, name), r = readRecord(h, p.record); let state = "ERROR"; let detail = "invalid record";
    if (!r) { state = "ORPHAN"; detail = "no record"; }
    else if (!h.exists(r.node) || !h.exists(r.cli)) detail = "node or cli missing";
    else if (h.platform === "darwin") { const q = h.run("launchctl", ["print", `gui/${h.uid}/com.orch-os.schedule.${name}`]); if (q.code && /not found|could not find/i.test(q.err + q.out)) { state = "MISSING"; detail = "not loaded"; } else if (q.code) detail = "launchctl failed"; else if (!/state\s*=|path\s*=|service/i.test(q.out)) detail = "unrecognised launchctl output"; else if (h.exists(p.launch) && h.read(p.launch) === plist(r)) { state = "LOADED"; detail = "loaded"; } else detail = "different command"; }
    else { const en = h.run("systemctl", ["--user", "is-enabled", posix.basename(p.timer)]), ac = h.run("systemctl", ["--user", "is-active", posix.basename(p.timer)]); const enabled = en.code === 0 && en.out.trim() === "enabled", active = ac.code === 0 && ac.out.trim() === "active"; if (!enabled && !active && /disabled|not-found|inactive/.test(en.out + ac.out)) { state = "MISSING"; detail = "not enabled or active"; } else if (enabled && active && h.exists(p.service) && h.exists(p.timer) && h.read(p.service) === service(r) && h.read(p.timer) === timer(r)) { state = "LOADED"; detail = "enabled and active"; } else detail = "manager or unit mismatch"; }
    let last = "never ran"; try { last = h.read(p.log).trim().split("\n").at(-1) || last; } catch {} rows.push({ name, state, detail, last }); }
  if (json) io.out(JSON.stringify(rows) + "\n"); else for (const r of rows) io.out(`${r.name} ${r.state} ${r.last}\n`); return rows.every((r) => r.state === "LOADED") ? 0 : 1;
}

export function remove(h: Host, io: ScheduleIO, name: string): number {
  if (!backend(h)) { io.err(refusal(h) + "\n"); return 2; } if (!NAME.test(name ?? "")) { io.err("schedule: invalid NAME; nothing was installed or changed\n"); return 2; }
  const p = paths(h, name), present = [p.record, p.launch, p.service, p.timer].some((x) => h.exists(x)); if (!present) { io.out(`not scheduled ${name}\n`); return 0; }
  const b = backend(h)!; const units = b === "launchd" ? [p.launch] : [p.service, p.timer]; for (const x of units) if (h.exists(x) && !owned(h, x, x === p.service ? "ExecStart=" : undefined)) { io.err(`schedule: ${x} is foreign or state is unknown; nothing was removed\n`); return 1; }
  const q = b === "launchd" ? h.run("launchctl", ["bootout", `gui/${h.uid}/com.orch-os.schedule.${name}`]) : h.run("systemctl", ["--user", "disable", "--now", posix.basename(p.timer)]); if (q.code && !/not loaded|not found|not enabled/i.test(q.err + q.out)) return fail(io, b === "launchd" ? "bootout" : "disable", q);
  if (b === "systemd") { const d = h.run("systemctl", ["--user", "daemon-reload"]); if (d.code) return fail(io, "daemon-reload", d); }
  for (const x of [...units, p.record, p.log]) if (h.exists(x)) h.remove(x); io.out(`removed ${name}\n`); return 0;
}

export function nodeHost(cli: string): Host {
  const run = (tool: string, args: string[]): Result => { const r = spawnSync(tool, args, { encoding: "utf8", timeout: 15_000 }); return { code: r.status ?? 1, out: r.stdout ?? "", err: r.error?.message ?? r.stderr ?? "" }; };
  return { platform: process.platform, home: process.env.HOME || homedir(), uid: process.getuid?.() ?? -1, node: process.execPath, cli: resolve(cli), orchHome: resolve(process.env.ORCH_HOME || posix.join(process.env.HOME || homedir(), ".orch")), envOrchHome: process.env.ORCH_HOME,
    run, exists: existsSync, lstat: lstatSync, read: (p) => readFileSync(p, "utf8"), write: (p, t) => { const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, t, { mode: 0o600 }); renameSync(tmp, p); }, append: appendFileSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }), remove: unlinkSync, list: (p) => { try { return readdirSync(p); } catch { return []; } } };
}
