// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Daily unattended workers registered with the current user's operating-system scheduler. */
import { spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
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
  readNoFollow?(path: string): string;
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
  isRefusal?(error: unknown): boolean;
}

function command(r: ScheduleRecord): string[] { return [r.node, r.cli, "schedule", "run", r.name]; }
function xml(s: string): string { return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function plist(r: ScheduleRecord): string {
  const [hour, minute] = r.daily.split(":").map(Number);
  const env = r.orchHome === undefined ? "" : `\n  <key>EnvironmentVariables</key><dict><key>ORCH_HOME</key><string>${xml(r.orchHome)}</string></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARK} -->\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.orch-os.schedule.${xml(r.name)}</string>\n  <key>ProgramArguments</key><array>${command(r).map((x) => `<string>${xml(x)}</string>`).join("")}</array>${env}\n  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>\n</dict></plist>\n`;
}
// systemd.syntax(7), Quoting: specifier expansion and $ expansion are separate.
function execQuote(s: string): string { return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`; }
function envQuote(s: string): string { return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
function service(r: ScheduleRecord): string {
  const env = r.orchHome === undefined ? "" : `Environment=${envQuote(`ORCH_HOME=${r.orchHome}`)}\n`;
  return `# ${MARK}\n[Unit]\nDescription=orch scheduled worker ${r.name}\n[Service]\nType=oneshot\n${env}ExecStart=${command(r).map(execQuote).join(" ")}\n`;
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
function record(h: Host, path: string): { kind: "missing" | "invalid" | "valid"; value?: ScheduleRecord; text?: string } {
  if (!h.exists(path)) return { kind: "missing" };
  try { const text = (h.readNoFollow ?? h.read)(path); const value = JSON.parse(text); return validRecord(value) ? { kind: "valid", value, text } : { kind: "invalid" }; }
  catch { return { kind: "invalid" }; }
}
function readRecord(h: Host, path: string): ScheduleRecord | null { const x = record(h, path); return x.kind === "valid" ? x.value! : null; }
function owned(h: Host, path: string, exact: string): boolean {
  try { const st = h.lstat(path); return !st.isSymbolicLink() && st.isFile() && (h.readNoFollow ?? h.read)(path) === exact; } catch { return false; }
}
function writeAll(h: Host, files: [string, string][]): void { for (const [p] of files) h.mkdir(dirname(p)); for (const [p, t] of files) h.write(p, t); }
function fail(io: ScheduleIO, step: string, r: Result): number { io.err(`schedule: ${step} failed${r.err.trim() ? `: ${r.err.trim()}` : ""}\n`); return 1; }
type Registration = "registered" | "not-registered" | "unknown";
function registered(h: Host, b: "launchd" | "systemd", p: ReturnType<typeof paths>, name: string): Registration {
  if (b === "launchd") { const q = h.run("launchctl", ["print", `gui/${h.uid}/com.orch-os.schedule.${name}`]); return q.code === 0 ? "registered" : q.code === 113 ? "not-registered" : "unknown"; }
  const en = h.run("systemctl", ["--user", "is-enabled", posix.basename(p.timer)]);
  const ac = h.run("systemctl", ["--user", "is-active", posix.basename(p.timer)]);
  const enabled = en.code === 0 && en.out.trim() === "enabled", active = ac.code === 0 && ac.out.trim() === "active";
  const disabled = en.code === 1 && ["disabled", "not-found"].includes(en.out.trim());
  const inactive = [3, 4].includes(ac.code) && ["inactive", "unknown"].includes(ac.out.trim());
  return enabled && active ? "registered" : disabled && inactive ? "not-registered" : "unknown";
}
function isLink(h: Host, path: string): boolean { try { return h.lstat(path).isSymbolicLink(); } catch { return false; } }
function hasMark(h: Host, path: string): boolean { try { const text = (h.readNoFollow ?? h.read)(path); return !isLink(h, path) && h.lstat(path).isFile() && text.includes(MARK) && (path.endsWith(".plist") ? text.includes("<plist") : path.endsWith(".timer") ? text.includes("[Timer]") : text.includes("[Service]")); } catch { return false; } }
function unsafePath(h: Host, path: string, jobFile = false): boolean { return isLink(h, path) || (jobFile && h.exists(path) && !hasMark(h, path)); }
function badLineValue(s: string): boolean { return /[\r\n\0]/.test(s); }

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
  const r: ScheduleRecord = { name: a.name, daily: a.daily, task, agent, workdir, node: h.node, cli: h.cli, orchHome: h.orchHome };
  if ([r.node, r.cli, r.orchHome ?? ""].some(badLineValue)) { io.err("schedule: a scheduler path contains a line break or NUL; nothing was installed or changed\n"); return 2; }
  const p = paths(h, r.name); const units: [string, string][] = b === "launchd" ? [[p.launch, plist(r)]] : [[p.service, service(r)], [p.timer, timer(r)]];
  const prior = record(h, p.record); const old = prior.kind === "valid" ? prior.value! : null;
  const oldUnits: [string, string][] = old ? (b === "launchd" ? [[p.launch, plist(old)]] : [[p.service, service(old)], [p.timer, timer(old)]]) : [];
  for (const path of [p.record, p.log]) if (unsafePath(h, path)) { io.err(`schedule: ${path} is a symbolic link; nothing was installed or changed\n`); return 2; }
  for (const [path] of units) if (unsafePath(h, path, true)) {
    io.err(`schedule: ${path} is foreign or a symbolic link; nothing was installed or changed\n`); return 2;
  }
  const recText = JSON.stringify(r, null, 2) + "\n";
  if (a.dry_run) { for (const [x, t] of [...units, [p.record, recText] as [string, string]]) io.out(`--- ${x}\n${t}`); io.out("scheduler was not asked (dry run)\n"); return 0; }
  if (b === "systemd" && !(h.managerAvailable ? h.managerAvailable() : h.run("systemctl", ["--user", "show-environment"]).code === 0)) {
    io.err("schedule: systemctl --user did not answer; nothing was installed or changed\n"); return 2;
  }
  const diskPresent = [p.record, ...units.map(([x]) => x)].some((x) => h.exists(x));
  const before = diskPresent ? registered(h, b, p, r.name) : "not-registered";
  if (before === "unknown") { io.err("schedule: query failed: scheduler state could not be determined\n"); return 1; }
  if (old && prior.text === recText && units.every(([x, t]) => h.exists(x) && owned(h, x, t)) && before === "registered") { io.out(`unchanged ${r.name}\n`); return 0; }
  if (before === "registered") {
    const q = b === "launchd" ? h.run("launchctl", ["bootout", `gui/${h.uid}/com.orch-os.schedule.${r.name}`]) : h.run("systemctl", ["--user", "disable", "--now", posix.basename(p.timer)]);
    if (q.code !== 0) return fail(io, b === "launchd" ? "bootout" : "disable", q);
  }
  const snapshots = [...units, [p.record, recText] as [string, string]].map(([x]) => [x, h.exists(x) ? h.read(x) : null] as const);
  const rollback = () => { for (const [x, text] of snapshots) { if (text === null) { if (h.exists(x)) h.remove(x); } else h.write(x, text); } };
  writeAll(h, units);
  const restore = () => { rollback(); if (before === "registered" && oldUnits.length) { if (b === "launchd") h.run("launchctl", ["bootstrap", `gui/${h.uid}`, p.launch]); else { h.run("systemctl", ["--user", "daemon-reload"]); h.run("systemctl", ["--user", "enable", "--now", posix.basename(p.timer)]); } } };
  if (b === "launchd") { const q = h.run("launchctl", ["bootstrap", `gui/${h.uid}`, p.launch]); if (q.code) { restore(); return fail(io, "bootstrap", q); } }
  else { let q = h.run("systemctl", ["--user", "daemon-reload"]); if (q.code) { restore(); return fail(io, "daemon-reload", q); } q = h.run("systemctl", ["--user", "enable", "--now", posix.basename(p.timer)]); if (q.code) { restore(); return fail(io, "enable --now", q); } }
  h.mkdir(dirname(p.record)); h.write(p.record, recText);
  io.out(`scheduled ${r.name} daily ${r.daily} (${b})\n`); return 0;
}

export function runScheduled(h: Host, io: ScheduleIO, name: string, rt: Runtime): number {
  if (!backend(h)) { io.err(refusal(h) + "\n"); return 2; }
  if (!NAME.test(name ?? "")) { io.err("schedule: invalid NAME\n"); return 2; }
  const p = paths(h, name); if (isLink(h, p.record) || isLink(h, p.log)) { io.err(`schedule: symbolic link at ${isLink(h, p.record) ? p.record : p.log}; nothing was written\n`); return 2; }
  const r = readRecord(h, p.record); if (!r || r.name !== name) { io.err(`schedule: unknown or invalid record ${name}\n`); return 2; }
  const cfg = rt.config(); rt.sample(cfg);
  try { const x = rt.start(cfg, `sched-${name}`, { agent: r.agent, task: r.task, workdir: r.workdir, limit: rt.limit(cfg) }); h.mkdir(dirname(p.log)); h.append(p.log, `${new Date().toISOString()} STARTED pid=${x.pid}\n`); return 0; }
  catch (e: any) { const refused = rt.isRefusal?.(e) ?? false; const word = refused ? "REFUSED" : "CRASHED"; h.mkdir(dirname(p.log)); h.append(p.log, `${new Date().toISOString()} ${word} ${e?.message ?? e}\n`); io.err(`schedule: run ${refused ? "refused" : "crashed"}: ${e?.message ?? e}\n`); return refused ? 2 : 1; }
}

function names(h: Host): string[] {
  const found = new Set<string>(); const add = (dir: string, re: RegExp) => { for (const x of h.list(dir)) { const m = re.exec(x); if (m) found.add(m[1]); } };
  add(posix.join(h.orchHome, "schedule"), /^([a-z0-9][a-z0-9-]{0,31})\.json$/);
  if (h.platform === "darwin") add(posix.join(h.home, "Library/LaunchAgents"), /^com\.orch-os\.schedule\.([a-z0-9][a-z0-9-]{0,31})\.plist$/);
  if (h.platform === "linux") add(posix.join(h.home, ".config/systemd/user"), /^orch-os-schedule-([a-z0-9][a-z0-9-]{0,31})\.(?:service|timer)$/);
  return [...found].sort();
}
export function status(h: Host, io: ScheduleIO, json = false): number {
  const b = backend(h); if (!b) { io.err(refusal(h) + "\n"); return 2; }
  const ns = names(h); if (!ns.length) { io.out(json ? "[]\n" : "no scheduled jobs\n"); return 0; }
  const rows: any[] = [];
  for (const name of ns) {
    const p = paths(h, name), jobPaths = b === "launchd" ? [p.launch] : [p.service, p.timer];
    const recordExists = h.exists(p.record), jobFileExists = jobPaths.some((x) => h.exists(x));
    let state = "ERROR", detail = "unsafe or invalid file", last = "never ran";
    if (![p.record, p.log].some((x) => unsafePath(h, x)) && !jobPaths.some((x) => unsafePath(h, x, true))) {
      const rr = record(h, p.record), reg = registered(h, b, p, name);
      if (reg === "unknown") detail = "scheduler state could not be determined";
      else if (rr.kind !== "valid") { state = rr.kind === "missing" ? "ORPHAN" : "ERROR"; detail = rr.kind === "missing" ? (reg === "registered" ? "registered; no record" : "not registered; no record") : "invalid record"; }
      else {
        const expected = b === "launchd" ? [[p.launch, plist(rr.value!)]] : [[p.service, service(rr.value!)], [p.timer, timer(rr.value!)]];
        const exact = expected.every(([x, text]) => h.exists(x) && owned(h, x, text));
        if (!h.exists(rr.value!.node) || !h.exists(rr.value!.cli)) detail = "node or cli missing";
        else if (reg === "registered" && exact) { state = "LOADED"; detail = "registered"; }
        else if (reg === "not-registered" && exact) { state = "MISSING"; detail = "not registered"; }
        else detail = "registration or job file mismatch";
      }
      if (!isLink(h, p.log)) try { last = h.read(p.log).trim().split("\n").at(-1) || last; } catch {}
    }
    rows.push({ name, state, detail, record: recordExists, jobFile: jobFileExists, last });
  }
  if (json) io.out(JSON.stringify(rows) + "\n"); else for (const r of rows) io.out(`${r.name} ${r.state} ${r.last}\n`);
  return rows.every((r) => r.state === "LOADED") ? 0 : 1;
}

export function remove(h: Host, io: ScheduleIO, name: string): number {
  const b = backend(h); if (!b) { io.err(refusal(h) + "\n"); return 2; }
  if (!NAME.test(name ?? "")) { io.err("schedule: invalid NAME; nothing was installed or changed\n"); return 2; }
  const p = paths(h, name), jobPaths = b === "launchd" ? [p.launch] : [p.service, p.timer];
  for (const x of [p.record, p.log]) if (unsafePath(h, x)) { io.err(`schedule: ${x} is a symbolic link; nothing was removed\n`); return 1; }
  for (const x of jobPaths) if (unsafePath(h, x, true)) { io.err(`schedule: ${x} is foreign or a symbolic link; nothing was removed\n`); return 1; }
  const before = registered(h, b, p, name);
  if (before === "unknown") { io.err("schedule: query failed: scheduler state could not be determined\n"); return 1; }
  if (before === "registered") {
    const q = b === "launchd" ? h.run("launchctl", ["bootout", `gui/${h.uid}/com.orch-os.schedule.${name}`]) : h.run("systemctl", ["--user", "disable", "--now", posix.basename(p.timer)]);
    if (q.code) return fail(io, b === "launchd" ? "bootout" : "disable", q);
  }
  const after = registered(h, b, p, name);
  if (after !== "not-registered") { io.err("schedule: confirmation failed: scheduler did not confirm removal\n"); return 1; }
  for (const x of [...jobPaths, p.record, p.log]) if (h.exists(x)) h.remove(x);
  if (b === "systemd") { const d = h.run("systemctl", ["--user", "daemon-reload"]); if (d.code) return fail(io, "daemon-reload", d); }
  io.out(`removed ${name}\n`); return 0;
}

export function nodeHost(cli: string): Host {
  const run = (tool: string, args: string[]): Result => { const r = spawnSync(tool, args, { encoding: "utf8", timeout: 15_000 }); return { code: r.status ?? 1, out: r.stdout ?? "", err: r.error?.message ?? r.stderr ?? "" }; };
  return { platform: process.platform, home: process.env.HOME || homedir(), uid: process.getuid?.() ?? -1, node: process.execPath, cli: resolve(cli), orchHome: resolve(process.env.ORCH_HOME || posix.join(process.env.HOME || homedir(), ".orch")), envOrchHome: process.env.ORCH_HOME,
    run, exists: existsSync, lstat: lstatSync, read: (p) => readFileSync(p, "utf8"), readNoFollow: (p) => { const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); try { const size = fstatSync(fd).size; const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); return buf.toString("utf8"); } finally { closeSync(fd); } }, write: (p, t) => { const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, t, { mode: 0o600 }); renameSync(tmp, p); }, append: appendFileSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }), remove: unlinkSync, list: (p) => { try { return readdirSync(p); } catch { return []; } } };
}
