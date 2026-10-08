// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Admission rules, extended to the commands actually selected for this launch. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { configNumber } from "./config.js";
import { TIERS, thresholds } from "./load.js";
import * as P from "./profile.js";
import * as RW from "./reviewwatch.js";
import { isPlainObject, which } from "./util.js";

/** `unverified` marks a row readiness could not check; it is never OK and never READY. */
export interface Check { name: string; ok: boolean; detail: string; unverified?: boolean }
export interface Probes {
  which(cmd: string): string | null;
  exitCode(bin: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): number | null;
  output(bin: string, args: string[], cwd: string): string | null;
}
export const defaultProbes: Probes = {
  which,
  exitCode: (bin, args, cwd, env) => {
    const r = spawnSync(bin, args, { cwd, env, stdio: "ignore", timeout: 15_000 });
    return r.error ? null : r.status; // a signal or probe timeout is failure
  },
  output: (bin, args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 15_000 });
    return !r.error && r.status === 0 ? r.stdout.trim() : null;
  },
};
const AUTH_STATUS = new Map<string, string[]>([["claude", ["auth", "status"]], ["codex", ["login", "status"]]]);

/** Reject wrong-type, blank, pseudo-path and .git suffix cases. */
export function mergeRepoProblem(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return "[merge] repo must be a non-blank owner/name string";
  const parts = v.split("/");
  if (parts.length !== 2) return "[merge] repo must be owner/name";
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || owner.includes("--") ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.startsWith("-") || /^\.+$/.test(repo) ||
      repo === ".git" || repo.toLowerCase().endsWith(".git")) return "[merge] repo is not a usable GitHub owner/name";
  return null;
}
export function timeLimitProblem(minutes: unknown): string | null {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 &&
    Number.isSafeInteger(Math.trunc(minutes * 60)) && Math.trunc(minutes * 60) >= 1
    ? null : "time limit must be finite, positive and at least one second";
}

export interface Selection {
  command?: unknown;
  agent?: string | null;
  workerIdentity?: string | null;
  reviewer?: string | null;
  minutes?: number | null;
  workdir?: string | null;
  commandWorkdir?: string;
  name?: string;
  env?: Record<string, string>;
}
export function workerCommand(cfg: Record<string, any>, s: Selection): unknown {
  if (s.agent && Array.isArray(s.command) && s.command.length) throw new Error("pass --agent or a command after --, not both");
  if (s.agent) {
    if (!Object.hasOwn(cfg.agents ?? {}, s.agent)) throw new Error(`no [agents.${s.agent}] in config`);
    return cfg.agents[s.agent].command;
  }
  return s.command ?? cfg.workers?.command;
}

/** Inspect only argv[0]. Wrappers are not parsed and arguments are never scanned. */
export function commandChecks(label: string, raw: unknown, s: Selection, probes: Probes = defaultProbes): Check[] {
  const rows: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name: `${label} ${name}`, ok, detail });
  if (!Array.isArray(raw) || !raw.length || raw.some((w) => typeof w !== "string") || !raw[0]) {
    add("command", false, "expected a non-empty argv array of strings; shell commands cannot be verified");
    add("auth", false, "no verifiable executable");
    return rows;
  }
  const cmd = raw.map((w: string) => w.replaceAll("{name}", s.name ?? "readiness").replaceAll("{workdir}", s.workdir ?? process.cwd()));
  const commandCwd = s.commandWorkdir ?? s.workdir ?? process.cwd();
  const word = cmd[0];
  const executable = word.includes("/") ? resolve(commandCwd, word) : word;
  const bin = probes.which(executable);
  add("command", bin !== null, bin ?? `${word} not on PATH`);
  if (!bin) { add("auth", false, "executable unavailable"); return rows; }
  // Login is verified only for a CLI with a real login-status command. Every other executable,
  // wrappers and unknown CLIs alike, is UNVERIFIED: it is not run, and --version is never login.
  const name = basename(word);
  const args = AUTH_STATUS.get(name);
  if (!args) {
    rows.push({ name: `${label} auth`, ok: false, unverified: true, detail: `no login-status probe is known for '${name}'; only ${[...AUTH_STATUS.keys()].join(" and ")} can be verified, and wrappers are not parsed` });
    return rows;
  }
  const code = probes.exitCode(bin, args, s.workdir ?? process.cwd(), { ...process.env, ...s.env });
  add("auth", code === 0, `${word} ${args.join(" ")}: ${code === null ? "could not run (timeout, signal or spawn error)" : `exit ${code}`}`);
  return rows;
}

export function readiness(cfg: Record<string, any>, loadPath: string, s: Selection = {}, probes = defaultProbes): Check[] {
  const rows: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });
  add("Node minimum", Number(process.versions.node.split(".")[0]) >= 22, "requires Node.js >=22");
  add("platform", ["darwin", "linux"].includes(process.platform), "requires macOS or Linux");
  if ((process.env.PATH ?? "").split(":").some((p) => !isAbsolute(p))) add("execution environment", false, "PATH must contain only absolute directories for unattended launch");
  if (s.env?.PATH !== undefined && s.env.PATH !== process.env.PATH) add("execution environment", false, "worker PATH override cannot be verified");
  let command: unknown;
  try { command = workerCommand(cfg, s); } catch (e: any) { add("worker selection", false, e.message); }
  rows.push(...commandChecks("worker", command, s, probes));
  try {
    const agents = RW.readAgents(cfg);
    // Review dispatch supplies its already-selected reviewer; ordinary launch uses watch's policy.
    let selected = s.reviewer ? agents.find((a) => a.name === s.reviewer) : null;
    if (!s.reviewer) {
      const inferred = s.workerIdentity ?? s.agent ?? Object.keys(cfg.agents ?? {}).find((n) => JSON.stringify(cfg.agents[n].command) === JSON.stringify(command));
      const choice = RW.chooseReviewer({ agents, authors: inferred ? [inferred] : [], profile: P.readProfile(cfg), which: probes.which });
      selected = agents.find((a) => a.name === choice.pick?.name);
      if (!selected) add("reviewer selection", false, choice.reason ?? "no reviewer selected");
    } else if (!selected) add("reviewer selection", false, `no [review.agents.${s.reviewer}] configured`);
    rows.push(...commandChecks("reviewer", selected?.argv, s, probes));
  } catch (e: any) {
    add("reviewer selection", false, e.message);
    rows.push(...commandChecks("reviewer", undefined, s, probes));
  }
  const repoProblem = mergeRepoProblem(cfg.merge?.repo);
  add("merge repo", repoProblem === null, repoProblem ?? cfg.merge.repo);
  const git = probes.which("git");
  const cwd = s.workdir ?? process.cwd();
  const repo = git && probes.output(git, ["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  add("git repo", Boolean(repo), repo ? cwd : "working directory is not a valid git repository");
  const origin = git && repo ? probes.output(git, ["remote", "get-url", "origin"], cwd) : null;
  add("origin", Boolean(origin), origin || "git repository has no origin");
  const gh = probes.which("gh");
  add("gh", gh !== null, gh ?? "gh not on PATH");
  const ghCode = gh ? probes.exitCode(gh, ["auth", "status"], cwd, { ...process.env, ...s.env }) : null;
  add("gh auth", ghCode === 0, ghCode === null ? "gh auth status: could not run" : `gh auth status: exit ${ghCode}`);
  let minutes: number | null = null;
  try { minutes = s.minutes ?? configNumber(cfg.workers?.timeout_minutes, 60, "[workers] timeout_minutes"); }
  catch (e: any) { add("worker limits", false, e.message); }
  const limit = timeLimitProblem(minutes);
  add("time limit", limit === null, limit ?? `${minutes} minutes`);
  const timeout = probes.which("timeout") ?? probes.which("gtimeout");
  // Exercise the same timeout syntax that start uses, with a no-spend Node process.
  const enforced = timeout && probes.exitCode(timeout, ["1", process.execPath, "-e", "process.exit(0)"]) === 0;
  add("timeout", Boolean(enforced), enforced ? timeout! : "timeout/gtimeout missing or unusable");
  try {
    const state = JSON.parse(readFileSync(loadPath, "utf8"));
    if (!isPlainObject(state) || !TIERS.includes(state.tier)) throw new Error("missing or invalid tier");
    const maxAge = configNumber(cfg.load?.max_age_seconds, 120, "[load] max_age_seconds", 1);
    const age = Date.now() / 1000 - state.ts;
    if (typeof state.ts !== "number" || !Number.isFinite(age) || age < -1 || age > maxAge) throw new Error(`stale or invalid timestamp (maximum age ${maxAge}s); run orch load`);
    const required = new Set(thresholds(cfg).flatMap(([, limits]) => Object.keys(limits)));
    required.add("load_ratio");
    for (const signal of required) if (typeof state[signal] !== "number" || !Number.isFinite(state[signal]) || state[signal] < 0) throw new Error(`required signal ${signal} missing or invalid; run orch load`);
    const blocks = cfg.workers?.block_tiers ?? ["HIGH", "CRITICAL"];
    if (!Array.isArray(blocks) || blocks.some((t) => !TIERS.includes(t))) throw new Error("invalid [workers] block_tiers");
    if (blocks.includes(state.tier)) throw new Error(`load tier ${state.tier} blocks launch`);
    add("required-check load state", true, `${state.tier}, age ${Math.max(0, Math.trunc(age))}s`);
  } catch (e: any) { add("required-check load state", false, e.message); }
  return rows;
}
export function render(rows: Check[]): string[] {
  const fails = rows.filter((r) => !r.ok && !r.unverified);
  const unverified = rows.filter((r) => r.unverified);
  const label = (r: Check) => (r.unverified ? "UNVERIFIED" : r.ok ? "OK" : "FAIL");
  const why = [fails.length ? `failing checks: ${fails.map((r) => r.name).join(", ")}` : "", unverified.length ? `unverified checks: ${unverified.map((r) => r.name).join(", ")}` : ""].filter(Boolean).join("; ");
  return [...rows.map((r) => `${label(r)}  ${r.name}${r.ok && !r.unverified ? `  ${r.detail}` : ` (${r.detail})`}`),
    why ? `ready-for-live: NOT READY; ${why}` : "ready-for-live: READY (unattended-ready)"];
}
