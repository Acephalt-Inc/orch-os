// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch lead install|status|uninstall --workspace PATH --host claude|codex`.
 *
 * These commands run before any ORCH configuration is read. They use the workspace and the
 * packaged text only: no ORCH home, no notes, no schedule, no host settings, no other program,
 * no network. Arguments are parsed and the workspace text is checked before any file access.
 * Exit code 0: complete (or dry run, or a status of INSTALLED or NOT_INSTALLED). 2: conflict,
 * partial, busy or unverifiable. 1: wrong usage or a file or output error.
 */
import nodePath, { type PlatformPath } from "node:path";
import { fileURLToPath } from "node:url";
import { type CmdSpec, HelpRequested, parse, UsageError } from "../args.js";
import { install, preflight, resolveWorkspace, type Conflict } from "./install.js";
import { COMMAND_BUDGET_MS, errorCode, type LeadEnv, LeadError, type LeadFs, loadPack, realFs } from "./pack.js";
import { type Host, HOSTS, PAYLOAD_COUNT, refuseWorkspaceText, STATE_DIR } from "./paths.js";
import { type AnchorState, type Liveness, readState, type RowWhy, type StateReport } from "./status.js";
import { type Preserved, uninstall } from "./uninstall.js";

/** Every fixed piece of text these commands print. `{name}` is filled in at run time. */
export const LEAD_TEXT = {
  help: "lead text pack in one workspace: install it, report on it, remove it; nothing that already exists is changed",
  helpInstall: "create the lead pack and one bootstrap file in a workspace that has neither",
  helpStatus: "report the state of every pack path in a workspace; reads only",
  helpUninstall: "remove the unchanged files install created; everything else stays",
  optWorkspace: "the workspace folder; it must exist",
  optHost: "the assistant the pack is for",
  optDryRun: "print every path install would create, then stop; creates nothing",
  usageInstall: "orch lead install --workspace PATH --host claude|codex [--dry-run]",
  usageStatus: "orch lead status --workspace PATH --host claude|codex",
  usageUninstall: "orch lead uninstall --workspace PATH --host claude|codex",
  required: "the following arguments are required: {names}",
  heading: "orch lead {command}: host {host}",
  workspace: "workspace: {workspace}",
  planIntro: "install will create these {count} paths; nothing that already exists is changed:",
  planLine: "  {kind} {path}",
  dryRun: "dry run: nothing was created",
  conflictIntro: "nothing was created; these paths already exist or cannot be used:",
  wouldRefuse: "an install here would be refused; these paths already exist or cannot be used:",
  conflictLine: "  {path}  ({why})",
  conflictExists: "exists",
  conflictNotDirectory: "is not a directory",
  conflictOther: "cannot be checked: {code}",
  reservedByOther: "nothing was created; another install reserved {path} first",
  result: "result: {aggregate}",
  created: "files created: {count} of {total}",
  stoppedCollision: "stopped at: {path} (it already exists and was left unchanged)",
  stoppedError: "stopped at: {path} ({detail})",
  afterStop: "what this run created was left in place; `orch lead status` lists it and `orch lead uninstall` removes it (same --workspace and --host)",
  activation: "host activation: unverified",
  activationNote: "the files are in place; this command does not check whether the assistant reads them",
  rowLine: "  {state} {path}{why}",
  whyEdited: "edited since install",
  whyOtherFile: "not the file install created",
  whyNotFile: "not a regular file",
  whyNoManifest: "no valid manifest, so ownership is unknown",
  whyNoAnchor: "its anchor is missing, so ownership is unknown",
  whyBadAnchor: "its anchor cannot be read, so ownership is unknown",
  whyUnstable: "changed while it was checked",
  whyUnreadable: "cannot be checked",
  stateAbsent: "state directory: {path} (absent)",
  stateInvalid: "state directory: {path} ({reason}; nothing in it is trusted or removed)",
  stateValid: "state directory: {path} (manifest valid; installer process {pid} {liveness})",
  liveDead: "is not running",
  liveAlive: "is running, or its id now belongs to another program",
  liveUnknown: "could not be checked",
  anchorsComplete: "  anchors complete: {count} of {total}",
  anchorMismatch: "  anchor without the reviewed text: {path}",
  anchorUnreadable: "  anchor that cannot be read: {path}",
  tmpSame: "  temporary manifest left behind (same file as the manifest): {path}",
  tmpDifferent: "  temporary manifest left behind (not the manifest): {path}",
  unknownEntry: "  unknown entry, not opened: {path}",
  removed: "  removed         {path}",
  alreadyAbsent: "  already absent  {path}",
  preserved: "  preserved       {path}  ({state}: {why})",
  stateRemoved: "  state removed   {path}",
  statePreserved: "  state preserved {path}  ({why})",
  directoryLeft: "  directory left  {path}",
  whyStateChanged: "does not hold the expected bytes",
  whyStateUnknown: "unknown entry, not opened",
  whyStateNotEmpty: "not empty",
  whyStateNeeded: "kept while a path above is preserved",
  nothingToRemove: "nothing to remove: this workspace has no state directory",
  nothingRemovedInvalid: "nothing was removed: {reason}; look at {path} and remove it by hand if you do not need it",
  nothingRemovedBusy: "nothing was removed: installer process {pid} {liveness}",
  residue: "some paths were preserved; they are listed above and nothing else was removed",
  directoriesNote: "directories are never removed; a new install for this host is refused while its pack directory exists",
  planPrintFailed: "orch lead: the list of paths could not be printed ({code}); nothing was created",
  outputFailed: "orch lead: output could not be written ({code})",
  errorLine: "orch lead: {message}",
  fileError: "file-system error {code} at {path}",
} as const;

function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

export interface LeadDeps {
  fs?: LeadFs;
  path?: PlatformPath;
  /** Standard output with a completion callback (process.stdout.write by default). */
  write?: (bytes: Buffer, done: (error?: Error | null) => void) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
  pid?: number;
  probe?: (pid: number) => void;
  now?: () => number;
  packageRoot?: string;
}

const option = (dest: string, flag: string, kind: "bool" | "str", help: string, extra: { metavar?: string; choices?: string[] } = {}) =>
  ({ dest, flags: [flag], kind, help, ...extra });

export function leadSpec(): CmdSpec<any> {
  const common = [
    option("workspace", "--workspace", "str", LEAD_TEXT.optWorkspace, { metavar: "PATH" }),
    option("host", "--host", "str", LEAD_TEXT.optHost, { metavar: "claude|codex", choices: [...HOSTS] }),
  ];
  return {
    name: "lead", help: LEAD_TEXT.help,
    sub: [
      { name: "install", help: LEAD_TEXT.helpInstall, usage: LEAD_TEXT.usageInstall, opts: [...common, option("dry_run", "--dry-run", "bool", LEAD_TEXT.optDryRun)] },
      { name: "status", help: LEAD_TEXT.helpStatus, usage: LEAD_TEXT.usageStatus, opts: common },
      { name: "uninstall", help: LEAD_TEXT.helpUninstall, usage: LEAD_TEXT.usageUninstall, opts: common },
    ],
  };
}

let stdoutErrorHandled = false;

/** Write to standard output and report completion. Without the listener a closed pipe would end the process before the callback is seen. */
function processWrite(bytes: Buffer, done: (error?: Error | null) => void): void {
  if (!stdoutErrorHandled) {
    process.stdout.on("error", () => {});
    stdoutErrorHandled = true;
  }
  process.stdout.write(bytes, (error) => done(error ?? null));
}

const WHY: Readonly<Record<Exclude<RowWhy, "">, string>> = {
  EDITED: LEAD_TEXT.whyEdited, OTHER_FILE: LEAD_TEXT.whyOtherFile, NOT_FILE: LEAD_TEXT.whyNotFile, NO_MANIFEST: LEAD_TEXT.whyNoManifest,
  NO_ANCHOR: LEAD_TEXT.whyNoAnchor, BAD_ANCHOR: LEAD_TEXT.whyBadAnchor, UNSTABLE: LEAD_TEXT.whyUnstable, UNREADABLE: LEAD_TEXT.whyUnreadable,
};
const STATE_WHY: Readonly<Record<string, string>> = {
  CHANGED: LEAD_TEXT.whyStateChanged, UNKNOWN_ENTRY: LEAD_TEXT.whyStateUnknown, NOT_EMPTY: LEAD_TEXT.whyStateNotEmpty, NEEDED: LEAD_TEXT.whyStateNeeded,
};
const LIVE: Readonly<Record<Liveness, string>> = { DEAD: LEAD_TEXT.liveDead, ALIVE: LEAD_TEXT.liveAlive, UNKNOWN: LEAD_TEXT.liveUnknown };

function conflictLines(conflicts: readonly Conflict[]): string[] {
  return conflicts.map((c) => fill(LEAD_TEXT.conflictLine, {
    path: c.path,
    why: c.why === "EXISTS" ? LEAD_TEXT.conflictExists : c.why === "NOT_A_DIRECTORY" ? LEAD_TEXT.conflictNotDirectory : fill(LEAD_TEXT.conflictOther, { code: c.why }),
  }));
}

/** The per-path and state lines of a report, shared by status and by install after a stop. */
function reportLines(env: LeadEnv, workspace: string, report: StateReport): string[] {
  const abs = (rel: string) => env.path.join(workspace, ...rel.split("/"));
  const lines = report.rows.map((row) => fill(LEAD_TEXT.rowLine, { state: row.state.padEnd(13), path: abs(row.path), why: row.why ? `  (${WHY[row.why]})` : "" }));
  const stateDir = abs(STATE_DIR);
  if (report.state === "ABSENT") {
    lines.push(fill(LEAD_TEXT.stateAbsent, { path: stateDir }));
  } else if (report.state === "INVALID" || !report.manifest) {
    lines.push(fill(LEAD_TEXT.stateInvalid, { path: stateDir, reason: report.reason }));
  } else {
    lines.push(fill(LEAD_TEXT.stateValid, { path: stateDir, pid: report.manifest.pid, liveness: LIVE[report.liveness ?? "DEAD"] }));
    const bad = (state: AnchorState) => state === "NOT_FILE" || state === "UNREADABLE";
    lines.push(fill(LEAD_TEXT.anchorsComplete, { count: report.rows.filter((r) => r.anchorState === "OK").length, total: PAYLOAD_COUNT }));
    for (const row of report.rows) {
      if (row.anchorState === "MISMATCH" && row.state !== "OWNED_CHANGED") lines.push(fill(LEAD_TEXT.anchorMismatch, { path: abs(`${STATE_DIR}/${row.anchor}`) }));
      if (bad(row.anchorState)) lines.push(fill(LEAD_TEXT.anchorUnreadable, { path: abs(`${STATE_DIR}/${row.anchor}`) }));
    }
    if (report.tmp !== "ABSENT") lines.push(fill(report.tmp === "SAME_AS_MANIFEST" ? LEAD_TEXT.tmpSame : LEAD_TEXT.tmpDifferent, { path: abs(`${STATE_DIR}/manifest.tmp`) }));
  }
  for (const rel of report.unknown) lines.push(fill(LEAD_TEXT.unknownEntry, { path: abs(rel) }));
  return lines;
}

function preservedLine(env: LeadEnv, workspace: string, p: Preserved): string {
  const path = env.path.join(workspace, ...p.path.split("/"));
  if (p.state === "STATE") return fill(LEAD_TEXT.statePreserved, { path, why: STATE_WHY[p.why] ?? p.why });
  return fill(LEAD_TEXT.preserved, { path, state: p.state, why: p.why === "" ? p.state : WHY[p.why as Exclude<RowWhy, "">] ?? p.why });
}

/** Run one `orch lead` command line (without the leading `lead`). Returns the exit code. */
export async function runLead(argv: string[], deps: LeadDeps = {}): Promise<number> {
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const write = deps.write ?? (deps.out ? (bytes: Buffer, done: (error?: Error | null) => void) => { deps.out!(bytes.toString("utf8")); done(null); } : processWrite);
  const emit = (lines: string[]) => new Promise<void>((resolve, reject) => {
    write(Buffer.from(lines.join("\n") + "\n", "utf8"), (error) => (error ? reject(error) : resolve()));
  });

  // 1. Arguments, before any file access.
  let parsed;
  try {
    parsed = parse(leadSpec(), argv, ["orch", "lead"]);
  } catch (e) {
    if (e instanceof HelpRequested) {
      await emit([e.text]);
      return 0;
    }
    if (e instanceof UsageError) {
      err(`${e.usage}\norch lead: error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const { args, cmd } = parsed;
  const missing = [args.workspace === null ? "--workspace" : "", args.host === null ? "--host" : ""].filter(Boolean);
  if (missing.length) {
    err(`usage: ${cmd.usage}\norch lead: error: ${fill(LEAD_TEXT.required, { names: missing.join(", ") })}\n`);
    return 1;
  }
  const host = args.host as Host;
  const path = deps.path ?? nodePath;
  const env: LeadEnv = {
    fs: deps.fs ?? realFs,
    path,
    now: deps.now ?? (() => performance.now()),
    pid: deps.pid ?? process.pid,
    probe: deps.probe ?? ((pid) => void process.kill(pid, 0)),
    packageRoot: deps.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)),
  };
  const deadline = env.now() + COMMAND_BUDGET_MS;

  try {
    // 2. The workspace: text check first, then it must be an existing real directory.
    const workspace = resolveWorkspace(env, String(args.workspace), (input) => refuseWorkspaceText(input, path));
    const head = [fill(LEAD_TEXT.heading, { command: cmd.name, host }), fill(LEAD_TEXT.workspace, { workspace })];
    const abs = (rel: string) => env.path.join(workspace, ...rel.split("/"));

    if (cmd.name === "status") {
      const report = readState(env, workspace, host, deadline);
      const lines = [...head, ...reportLines(env, workspace, report)];
      if (report.state === "ABSENT") {
        const pre = preflight(env, workspace, host);
        if (pre.conflicts.length) lines.push(LEAD_TEXT.wouldRefuse, ...conflictLines(pre.conflicts));
      }
      lines.push(fill(LEAD_TEXT.result, { aggregate: report.aggregate }), LEAD_TEXT.activation);
      await emit(lines);
      return report.aggregate === "INSTALLED" || report.aggregate === "NOT_INSTALLED" ? 0 : 2;
    }

    if (cmd.name === "uninstall") {
      const outcome = uninstall(env, workspace, host, deadline);
      const lines = [...head];
      for (const rel of outcome.removed) lines.push(fill(LEAD_TEXT.removed, { path: abs(rel) }));
      for (const rel of outcome.absent) lines.push(fill(LEAD_TEXT.alreadyAbsent, { path: abs(rel) }));
      for (const p of outcome.preserved) lines.push(preservedLine(env, workspace, p));
      for (const rel of outcome.stateRemoved) lines.push(fill(LEAD_TEXT.stateRemoved, { path: abs(rel) }));
      for (const rel of outcome.directoriesLeft) lines.push(fill(LEAD_TEXT.directoryLeft, { path: abs(rel) }));
      if (outcome.before.state === "ABSENT") lines.push(LEAD_TEXT.nothingToRemove);
      if (outcome.before.state === "INVALID") lines.push(fill(LEAD_TEXT.nothingRemovedInvalid, { reason: outcome.before.reason, path: abs(STATE_DIR) }));
      if (outcome.aggregate === "BUSY" && outcome.before.manifest) {
        lines.push(fill(LEAD_TEXT.nothingRemovedBusy, { pid: outcome.before.manifest.pid, liveness: LIVE[outcome.before.liveness ?? "UNKNOWN"] }));
      }
      if (outcome.preserved.length) lines.push(LEAD_TEXT.residue);
      if (outcome.directoriesLeft.length) lines.push(LEAD_TEXT.directoriesNote);
      lines.push(fill(LEAD_TEXT.result, { aggregate: outcome.aggregate }));
      await emit(lines);
      return outcome.aggregate === "NOT_INSTALLED" ? 0 : 2;
    }

    // install
    const pack = loadPack(host, env, deadline);
    const pre = preflight(env, workspace, host);
    if (pre.conflicts.length) {
      await emit([...head, fill(LEAD_TEXT.result, { aggregate: "CONFLICT" }), LEAD_TEXT.conflictIntro, ...conflictLines(pre.conflicts)]);
      return 2;
    }
    try {
      await emit([...head, fill(LEAD_TEXT.planIntro, { count: pre.lines.length }),
        ...pre.lines.map((line) => fill(LEAD_TEXT.planLine, { kind: line.kind.padEnd(9), path: line.path }))]);
    } catch (e) {
      err(fill(LEAD_TEXT.planPrintFailed, { code: errorCode(e) }) + "\n");
      return 1;
    }
    if (args.dry_run) {
      await emit([LEAD_TEXT.dryRun]);
      return 0;
    }
    const outcome = install(env, workspace, host, pack, pre.missingParents, deadline);
    if (outcome.stop === "RESERVED_BY_OTHER" || !outcome.report) {
      await emit([fill(LEAD_TEXT.result, { aggregate: "CONFLICT" }), fill(LEAD_TEXT.reservedByOther, { path: outcome.stoppedAt })]);
      return 2;
    }
    const created = fill(LEAD_TEXT.created, { count: outcome.published, total: PAYLOAD_COUNT });
    if (outcome.stop === "NONE" && outcome.report.aggregate === "INSTALLED") {
      await emit([fill(LEAD_TEXT.result, { aggregate: "INSTALLED" }), created, LEAD_TEXT.activation, LEAD_TEXT.activationNote]);
      return 0;
    }
    // Stopped, or the files on disk are not all as created: never reported as installed.
    const aggregate = outcome.report.aggregate === "INSTALLED" ? "PARTIAL" : outcome.report.aggregate;
    const lines = [fill(LEAD_TEXT.result, { aggregate }), created];
    if (outcome.stop === "COLLISION") lines.push(fill(LEAD_TEXT.stoppedCollision, { path: outcome.stoppedAt }));
    if (outcome.stop === "ERROR") lines.push(fill(LEAD_TEXT.stoppedError, { path: outcome.stoppedAt, detail: outcome.detail }));
    lines.push(...reportLines(env, workspace, outcome.report), LEAD_TEXT.afterStop, LEAD_TEXT.activation);
    await emit(lines);
    return outcome.stop === "ERROR" ? 1 : 2;
  } catch (e) {
    if (e instanceof LeadError) {
      err(fill(LEAD_TEXT.errorLine, { message: e.message }) + "\n");
      return 1;
    }
    const code = errorCode(e);
    if (code === "ERROR") throw e;
    const where = (e as { path?: unknown }).path;
    if (typeof where === "string") err(fill(LEAD_TEXT.errorLine, { message: fill(LEAD_TEXT.fileError, { code, path: where }) }) + "\n");
    else err(fill(LEAD_TEXT.outputFailed, { code }) + "\n");
    return 1;
  }
}
