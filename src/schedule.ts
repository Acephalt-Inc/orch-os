// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch schedule install|status|remove`: background jobs orch-os benefits from running
 * unattended, installed without sudo.
 *
 *   * macOS: one launchd user agent (~/Library/LaunchAgents/*.plist) per job.
 *   * Linux: one systemd --user service+timer pair (~/.config/systemd/user/) per job, or,
 *     when a systemd --user session is not reachable, a single marked block in the caller's
 *     own crontab (`crontab -l` / `crontab -`; still no sudo).
 *
 * Every job below is a real `orch` subcommand that exists in the build's own command tree
 * (checked with `hasCommand`, never assumed); a candidate whose subcommand is absent is
 * skipped and named by the caller (`orch schedule install`, `orch doctor`). Nothing here
 * invents a subcommand that isn't in src/cli.ts's tree.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CmdSpec } from "./args.js";
import { which as pathWhich } from "./util.js";

// ---- job candidates ----------------------------------------------------------------------------

export interface JobCandidate {
  readonly id: string;
  readonly label: string;
  /** The subcommand path, e.g. ["lease", "renew"], checked against the live command tree. */
  readonly argv: string[];
  /** Suggested period, in minutes. */
  readonly minutes: number;
  readonly note: string;
}

/**
 * Candidate periodic jobs. A "stuck-worker check" is deliberately NOT listed here: at this
 * version there is no CLI subcommand for it in src/ (the closest is `orch worker list`, which
 * reports RUNNING/STOPPED/UNKNOWN but takes no action and has no pass/fail exit code) - add a
 * JobCandidate once a real subcommand exists, rather than inventing one to schedule.
 */
export const CANDIDATES: JobCandidate[] = [
  {
    id: "lease-renew",
    label: "role lease renewal",
    argv: ["lease", "renew"],
    minutes: 5,
    note: "renews this identity's role lease; harmlessly exits non-zero (NOT_HOLDER/EXPIRED) when it does not currently hold one",
  },
  {
    id: "load-sample",
    label: "load/heat sampling",
    argv: ["load"],
    minutes: 1,
    note: "takes one load sample and advances the tier `orch worker start` reads",
  },
];

/**
 * Does `tree` have a runnable command at this path (not just a subcommand group)? Two shapes
 * both count: nested subcommands (`orch worker start` walks sub -> sub) and a single leaf
 * command whose last path segment is one of its positional action's choices (`orch lease renew`:
 * "lease" is a leaf with `pos: [{ choices: [..., "renew", ...] }]`, not a "renew" subcommand).
 */
export function hasCommand(tree: CmdSpec<any>, path: string[]): boolean {
  let node: CmdSpec<any> = tree;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const next = node.sub?.find((s) => s.name === seg);
    if (next) {
      node = next;
      continue;
    }
    if (node.run !== undefined && i === path.length - 1) return Boolean(node.pos?.[0]?.choices?.includes(seg));
    return false;
  }
  return node.run !== undefined;
}

export function available(tree: CmdSpec<any>): JobCandidate[] {
  return CANDIDATES.filter((c) => hasCommand(tree, c.argv));
}

export function unavailable(tree: CmdSpec<any>): JobCandidate[] {
  return CANDIDATES.filter((c) => !hasCommand(tree, c.argv));
}

// ---- host abstraction (injectable so tests never touch the real OS) --------------------------

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Host {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  which(cmd: string): string | null;
  exec(cmd: string, args: string[], input?: string): ExecResult;
}

export function realHost(): Host {
  return {
    platform: process.platform,
    home: process.env.HOME || "",
    uid: process.getuid ? process.getuid() : 0,
    which: pathWhich,
    exec: (cmd, args, input) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", input });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

export class ScheduleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ScheduleError";
  }
}

function ensureTool(host: Host, name: string): void {
  if (!host.which(name)) throw new ScheduleError(`'${name}' not found on PATH - required for this backend`);
}

// ---- backend detection --------------------------------------------------------------------------

export type BackendName = "launchd" | "systemd" | "cron";
export const BACKEND_NAMES: BackendName[] = ["launchd", "systemd", "cron"];

function systemdUserUsable(host: Host): boolean {
  if (!host.which("systemctl")) return false;
  try {
    const r = host.exec("systemctl", ["--user", "--no-pager", "is-system-running"]);
    const out = r.stdout.trim();
    return out === "running" || out === "degraded";
  } catch {
    return false;
  }
}

function hasSystemdUnits(host: Host): boolean {
  return CANDIDATES.some((job) => ["service", "timer"].some((ext) =>
    existsSync(join(systemdDir(host.home), `${systemdUnitName(job.id)}.${ext}`))));
}

export function installedBackend(host: Host): BackendName | null {
  if (host.platform === "darwin") return CANDIDATES.some((j) => existsSync(launchdPath(host.home, j.id))) ? "launchd" : null;
  if (host.platform !== "linux") return null;
  const units = hasSystemdUnits(host);
  const crontab = host.which("crontab") ? readCrontab(host) : "";
  const cron = crontab.includes(CRON_BEGIN) || crontab.includes(CRON_END);
  if (cron) stripManagedBlock(crontab); // refuse ambiguous/truncated state before switching backend
  if (units && cron) throw new ScheduleError("orch-os jobs exist in both systemd and cron; remove one backend explicitly");
  return units ? "systemd" : cron ? "cron" : null;
}

/** Preserve the installed backend across transient changes in the Linux user bus. */
export function detectBackend(host: Host): BackendName {
  if (host.platform === "darwin") return "launchd";
  if (host.platform === "linux") {
    const installed = installedBackend(host);
    if (installed === "systemd") {
      if (!systemdUserUsable(host)) throw new ScheduleError("systemd user bus unavailable while orch-os systemd units exist; retry when the bus is reachable");
      return "systemd";
    }
    if (installed) return installed;
    return systemdUserUsable(host) ? "systemd" : "cron";
  }
  throw new ScheduleError(`orch schedule has no backend for platform '${host.platform}' (supported: darwin, linux)`);
}

/** Use this package's own built executable, never an unrelated process or older PATH copy. */
export function resolveOrchBin(_argv1: string, _host: Host): string {
  const ownDist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  try {
    accessSync(ownDist, constants.X_OK);
    return realpathSync(ownDist);
  } catch {
    throw new ScheduleError("no executable orch CLI found in this build; run npm run build before installing jobs");
  }
}

export interface RunContext {
  /** Where per-user unit files live (launchd/systemd); normally host.home. */
  home: string;
  /** Absolute Node executable captured at install; scheduler PATH may not contain node. */
  nodeBin: string;
  /** Absolute path to the `orch` binary, baked into every installed job. */
  orchBin: string;
  /** ORCH_HOME to export explicitly, since none of the three backends inherit a login shell's env. */
  orchHome?: string;
  /** Where job stdout/stderr (launchd, systemd oneshot via journal is separate, cron) land. */
  logDir: string;
  /** Holder identity captured and verified when the renewal job is installed. */
  leaseSession?: string;
  /** Epoch fences the installed job after a different holder takes over. */
  leaseEpoch?: number;
}

// ---- rendering -----------------------------------------------------------------------------------

export interface RenderedFile {
  path: string;
  contents: string;
}

function commandArgs(job: JobCandidate, ctx: RunContext): string[] {
  if (job.id !== "lease-renew") return job.argv;
  if (!ctx.leaseSession || !/^[A-Za-z0-9_.:@/-]+$/.test(ctx.leaseSession)
      || typeof ctx.leaseEpoch !== "number" || !Number.isSafeInteger(ctx.leaseEpoch) || ctx.leaseEpoch < 1) {
    throw new ScheduleError("lease renewal needs a verified current holder and epoch");
  }
  return [...job.argv, "--session", ctx.leaseSession, "--expected-epoch", String(ctx.leaseEpoch)];
}

function invocationArgs(job: JobCandidate, ctx: RunContext): string[] {
  return [ctx.nodeBin, ctx.orchBin, ...commandArgs(job, ctx)];
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function systemdArg(s: string, forExec = false): string {
  const escaped = s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\$/g, () => forExec ? "$$" : "$");
  return /[\s"'\\]/.test(s) ? `"${escaped}"` : escaped;
}

function cronArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''").replace(/%/g, "\\%")}'`;
}

export function launchdLabel(id: string): string {
  return `com.orch-os.schedule.${id}`;
}

export function launchdPath(home: string, id: string): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(id)}.plist`);
}

function renderLaunchdFile(job: JobCandidate, ctx: RunContext): RenderedFile {
  const args = invocationArgs(job, ctx);
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envXml = ctx.orchHome
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ORCH_HOME</key>\n    <string>${xmlEscape(ctx.orchHome)}</string>\n  </dict>\n`
    : "";
  const out = join(ctx.logDir, `${job.id}.out.log`);
  const err = join(ctx.logDir, `${job.id}.err.log`);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel(job.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>StartInterval</key>
  <integer>${job.minutes * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(err)}</string>
</dict>
</plist>
`;
  return { path: launchdPath(ctx.home, job.id), contents };
}

export function systemdUnitName(id: string): string {
  return `orch-os-schedule-${id}`;
}

export function systemdDir(home: string): string {
  return join(home, ".config", "systemd", "user");
}

function renderSystemdFiles(job: JobCandidate, ctx: RunContext): [RenderedFile, RenderedFile] {
  const name = systemdUnitName(job.id);
  const envLine = ctx.orchHome ? `Environment=${systemdArg(`ORCH_HOME=${ctx.orchHome}`)}\n` : "";
  const svc: RenderedFile = {
    path: join(systemdDir(ctx.home), `${name}.service`),
    contents: `[Unit]
Description=orch-os scheduled job: ${job.label}

[Service]
Type=oneshot
${envLine}ExecStart=${invocationArgs(job, ctx).map((arg) => systemdArg(arg, true)).join(" ")}
`,
  };
  const timer: RenderedFile = {
    path: join(systemdDir(ctx.home), `${name}.timer`),
    contents: `[Unit]
Description=orch-os scheduled job timer: ${job.label}

[Timer]
OnBootSec=${job.minutes}min
OnUnitActiveSec=${job.minutes}min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
  return [svc, timer];
}

const CRON_BEGIN = "# BEGIN orch-os schedule (managed by `orch schedule`; do not edit by hand)";
const CRON_END = "# END orch-os schedule";

function cronExpr(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  return `*/${Math.max(1, Math.trunc(minutes))} * * * *`;
}

function cronLine(job: JobCandidate, ctx: RunContext): string {
  const envPrefix = ctx.orchHome ? `ORCH_HOME=${cronArg(ctx.orchHome)} ` : "";
  const log = join(ctx.logDir, `${job.id}.log`);
  return `${cronExpr(job.minutes)} ${envPrefix}${invocationArgs(job, ctx).map(cronArg).join(" ")} >>${cronArg(log)} 2>&1`;
}

function renderCronBlock(jobs: JobCandidate[], ctx: RunContext): string {
  return [CRON_BEGIN, ...jobs.map((j) => cronLine(j, ctx)), CRON_END].join("\n") + "\n";
}

function stripManagedBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(CRON_BEGIN);
  const end = lines.indexOf(CRON_END, start + 1);
  if (start === -1 && !lines.includes(CRON_END)) return text;
  if (start === -1 || end === -1 || lines.indexOf(CRON_BEGIN, start + 1) !== -1
      || lines.indexOf(CRON_END, end + 1) !== -1) {
    throw new ScheduleError("malformed orch-os managed block in crontab; refusing to change it");
  }
  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return rest.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The files `install` would write, for `--dry-run` (and reused by `install` itself). */
export function render(backend: BackendName, jobs: JobCandidate[], ctx: RunContext): RenderedFile[] {
  if (backend === "launchd") return jobs.map((j) => renderLaunchdFile(j, ctx));
  if (backend === "systemd") return jobs.flatMap((j) => renderSystemdFiles(j, ctx));
  return [{ path: "(crontab, managed block)", contents: renderCronBlock(jobs, ctx) }];
}

// ---- crontab helpers -----------------------------------------------------------------------------

function readCrontab(host: Host): string {
  const r = host.exec("crontab", ["-l"]);
  if (r.status === 0) return r.stdout;
  if (r.status === 1 && /\bno crontab for\b/i.test(r.stderr)) return "";
  throw new ScheduleError(`cannot read crontab: ${firstLine(r.stderr || r.stdout || `exit ${r.status}`)}`);
}

function writeCrontab(host: Host, text: string): ExecResult {
  return host.exec("crontab", ["-"], text);
}

// ---- install / status / remove -------------------------------------------------------------------

export interface InstallRow {
  id: string;
  path: string;
  activated: boolean;
  detail: string;
}

export function installExitCode(rows: InstallRow[]): number {
  return rows.every((row) => row.activated) ? 0 : 2;
}

export function install(backend: BackendName, jobs: JobCandidate[], ctx: RunContext, host: Host): InstallRow[] {
  if (!jobs.length) return [];
  mkdirSync(ctx.logDir, { recursive: true });
  if (backend === "launchd") {
    ensureTool(host, "launchctl");
    return jobs.map((job) => {
      const f = renderLaunchdFile(job, ctx);
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.contents);
      host.exec("launchctl", ["bootout", `gui/${host.uid}`, launchdLabel(job.id)]); // fine if not loaded
      const r = host.exec("launchctl", ["bootstrap", `gui/${host.uid}`, f.path]);
      const activated = r.status === 0;
      return { id: job.id, path: f.path, activated, detail: activated ? "loaded" : firstLine(r.stderr || r.stdout || `exit ${r.status}`) };
    });
  }
  if (backend === "systemd") {
    ensureTool(host, "systemctl");
    mkdirSync(systemdDir(ctx.home), { recursive: true });
    for (const job of jobs) {
      const [svc, timer] = renderSystemdFiles(job, ctx);
      writeFileSync(svc.path, svc.contents);
      writeFileSync(timer.path, timer.contents);
    }
    const reload = host.exec("systemctl", ["--user", "daemon-reload"]);
    if (reload.status !== 0) throw new ScheduleError(`cannot reload systemd user units: ${firstLine(reload.stderr || reload.stdout || `exit ${reload.status}`)}`);
    return jobs.map((job) => {
      const name = systemdUnitName(job.id);
      const r = host.exec("systemctl", ["--user", "enable", "--now", `${name}.timer`]);
      const activated = r.status === 0;
      return {
        id: job.id, path: join(systemdDir(ctx.home), `${name}.timer`), activated,
        detail: activated ? "enabled" : firstLine(r.stderr || r.stdout || `exit ${r.status}`),
      };
    });
  }
  // cron
  ensureTool(host, "crontab");
  const stripped = stripManagedBlock(readCrontab(host));
  const block = renderCronBlock(jobs, ctx);
  const next = (stripped.trim() ? stripped.replace(/\n*$/, "\n\n") : "") + block;
  const r = writeCrontab(host, next);
  const activated = r.status === 0;
  return jobs.map((job) => ({
    id: job.id, path: "(crontab)", activated,
    detail: activated ? "installed in crontab" : firstLine(r.stderr || `exit ${r.status}`),
  }));
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

export interface StatusRow {
  id: string;
  label: string;
  written: boolean;
  loaded: boolean;
  detail: string;
  degraded?: boolean;
}

function xmlValue(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function launchdNode(contents: string): string | null {
  const args = contents.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/);
  return args && isAbsolute(xmlValue(args[2]))
    ? xmlValue(args[1]) : null;
}

function systemdArgv(contents: string): string[] {
  let rest = contents.match(/^ExecStart=(.*)$/m)?.[1]?.trim() ?? "";
  const out: string[] = [];
  for (let i = 0; i < 2; i++) {
    const m = rest.match(/^("(?:\\.|[^"])*"|\S+)(?:\s+|$)/);
    if (!m) return [];
    const raw = m[1].startsWith('"') ? m[1].slice(1, -1) : m[1];
    out.push(raw.replace(/\\([\\"])/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$"));
    rest = rest.slice(m[0].length);
  }
  return out;
}

function systemdNode(contents: string): string | null {
  const args = systemdArgv(contents);
  return args.length === 2 && isAbsolute(args[1]) ? args[0] : null;
}

function cronQuoted(s: string): [string, string] | null {
  if (!s.startsWith("'")) return null;
  let value = "";
  for (let i = 1; i < s.length;) {
    if (s.slice(i, i + 4) === "'\\''") { value += "'"; i += 4; continue; }
    if (s[i] === "'") return [value, s.slice(i + 1).trimStart()];
    value += s[i++];
  }
  return null;
}

function cronNode(line: string): string | null {
  let rest = line.replace(/^(?:\S+\s+){5}/, "");
  if (rest.startsWith("ORCH_HOME=")) {
    const env = cronQuoted(rest.slice("ORCH_HOME=".length));
    if (!env) return null;
    rest = env[1];
  }
  const node = cronQuoted(rest);
  const cli = node && cronQuoted(node[1]);
  return cli && isAbsolute(cli[0]) ? node![0] : null;
}

function nodeHealth(node: string | null): string | null {
  if (!node || !isAbsolute(node)) return "installed job has no verifiable absolute Node executable; reinstall";
  try {
    accessSync(node, constants.X_OK);
    return null;
  } catch {
    return `captured Node ${node} missing or not executable; reinstall`;
  }
}

function installedNodeHealth(path: string, parse: (contents: string) => string | null): string {
  try {
    return nodeHealth(parse(readFileSync(path, "utf8"))) ?? "";
  } catch {
    return `cannot read installed job ${path}; reinstall`;
  }
}

export function status(backend: BackendName, jobs: JobCandidate[], ctx: RunContext, host: Host): StatusRow[] {
  if (backend === "launchd") {
    return jobs.map((job) => {
      const p = launchdPath(ctx.home, job.id);
      const written = existsSync(p);
      let loaded = false;
      let detail = "not loaded";
      try {
        const r = host.exec("launchctl", ["print", `gui/${host.uid}/${launchdLabel(job.id)}`]);
        loaded = r.status === 0;
        detail = loaded ? "loaded" : firstLine(r.stderr || r.stdout || "not loaded");
      } catch { /* leave defaults: not loaded */ }
      const error = loaded && written ? installedNodeHealth(p, launchdNode) : null;
      return { id: job.id, label: job.label, written, loaded: loaded && !error,
        detail: error ? `ERROR: ${error}` : written ? detail : "not installed", degraded: Boolean(error) };
    });
  }
  if (backend === "systemd") {
    return jobs.map((job) => {
      const name = systemdUnitName(job.id);
      const written = existsSync(join(systemdDir(ctx.home), `${name}.timer`));
      let loaded = false;
      let detail = "inactive";
      try {
        const r = host.exec("systemctl", ["--user", "is-active", `${name}.timer`]);
        detail = firstLine(r.stdout || r.stderr || `exit ${r.status}`);
        loaded = detail === "active";
      } catch { /* leave defaults */ }
      const svcPath = join(systemdDir(ctx.home), `${name}.service`);
      const error = loaded && written ? existsSync(svcPath)
        ? installedNodeHealth(svcPath, systemdNode) : nodeHealth(null) : null;
      return { id: job.id, label: job.label, written, loaded: loaded && !error,
        detail: error ? `ERROR: ${error}` : written ? detail : "not installed", degraded: Boolean(error) };
    });
  }
  // cron
  const text = readCrontab(host);
  return jobs.map((job) => {
    const command = `${cronArg(ctx.orchBin)} ${job.argv.map(cronArg).join(" ")}`;
    const line = text.split("\n").find((l) => l.includes(command));
    const present = Boolean(line);
    const error = line ? nodeHealth(cronNode(line)) : null;
    return { id: job.id, label: job.label, written: present, loaded: present && !error,
      detail: error ? `ERROR: ${error}` : present ? "in crontab" : "not installed", degraded: Boolean(error) };
  });
}

export interface RemoveRow {
  id: string;
  removed: boolean;
  detail: string;
}

export function remove(backend: BackendName, jobs: JobCandidate[], ctx: RunContext, host: Host): RemoveRow[] {
  if (!jobs.length) return [];
  if (backend === "launchd") {
    return jobs.map((job) => {
      const p = launchdPath(ctx.home, job.id);
      const written = existsSync(p);
      const state = host.exec("launchctl", ["print", `gui/${host.uid}/${launchdLabel(job.id)}`]);
      const loaded = state.status === 0;
      if (!loaded && !/could not find service|service not found/i.test(state.stderr)) {
        throw new ScheduleError(`cannot inspect ${launchdLabel(job.id)}: ${firstLine(state.stderr || state.stdout || `exit ${state.status}`)}`);
      }
      if (loaded) {
        const r = host.exec("launchctl", ["bootout", `gui/${host.uid}`, launchdLabel(job.id)]);
        if (r.status !== 0 && !/could not find service|service not found/i.test(r.stderr)) {
          throw new ScheduleError(`cannot deactivate ${launchdLabel(job.id)}: ${firstLine(r.stderr || r.stdout || `exit ${r.status}`)}`);
        }
      }
      if (written) unlinkSync(p);
      const removed = written || loaded;
      return { id: job.id, removed, detail: written ? `removed ${p}` : loaded ? `deactivated ${launchdLabel(job.id)}` : "was not installed" };
    });
  }
  if (backend === "systemd") {
    const rows = jobs.map((job) => {
      const name = systemdUnitName(job.id);
      const svc = join(systemdDir(ctx.home), `${name}.service`);
      const timer = join(systemdDir(ctx.home), `${name}.timer`);
      const written = existsSync(svc) || existsSync(timer);
      const state = host.exec("systemctl", ["--user", "is-active", `${name}.timer`]);
      const active = state.status === 0 && state.stdout.trim() === "active";
      const inactive = state.status === 3 && /^(inactive|failed)$/.test(state.stdout.trim());
      const missing = state.status === 4 && /not-found|could not be found|not found/i.test(state.stderr || state.stdout);
      if (!active && !inactive && !missing) {
        throw new ScheduleError(`cannot inspect ${name}.timer: ${firstLine(state.stderr || state.stdout || `exit ${state.status}`)}`);
      }
      const enableState = host.exec("systemctl", ["--user", "is-enabled", `${name}.timer`]);
      const enableText = enableState.stdout.trim();
      const enabled = enableState.status === 0 && /^(enabled|enabled-runtime)$/.test(enableText);
      const disabled = enableState.status !== 0 && /^(disabled|masked|masked-runtime)$/.test(enableText);
      const enableMissing = enableState.status === 4 && enableText === "not-found";
      if (!enabled && !disabled && !enableMissing) {
        throw new ScheduleError(`cannot inspect enablement of ${name}.timer: ${firstLine(enableState.stderr || enableState.stdout || `exit ${enableState.status}`)}`);
      }
      if (written || active || enabled) {
        const r = host.exec("systemctl", ["--user", "disable", "--now", `${name}.timer`]);
        if (r.status !== 0) throw new ScheduleError(`cannot deactivate ${name}.timer: ${firstLine(r.stderr || r.stdout || `exit ${r.status}`)}`);
      }
      let removed = active || enabled;
      for (const p of [svc, timer]) {
        if (existsSync(p)) {
          unlinkSync(p);
          removed = true;
        }
      }
      return { id: job.id, removed, detail: written ? `removed ${name}.service/.timer` : active || enabled ? `deactivated ${name}.timer` : "was not installed" };
    });
    const reload = host.exec("systemctl", ["--user", "daemon-reload"]);
    if (reload.status !== 0) throw new ScheduleError(`cannot reload systemd user units: ${firstLine(reload.stderr || reload.stdout || `exit ${reload.status}`)}`);
    return rows;
  }
  // cron
  const cur = readCrontab(host);
  const stripped = stripManagedBlock(cur);
  const changed = stripped !== cur;
  if (changed) {
    const r = writeCrontab(host, stripped);
    if (r.status !== 0) throw new ScheduleError(`cannot write crontab: ${firstLine(r.stderr || r.stdout || `exit ${r.status}`)}`);
  }
  return jobs.map((job) => ({ id: job.id, removed: changed, detail: changed ? "removed from crontab" : "was not installed" }));
}
