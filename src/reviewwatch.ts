// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch review watch PR --task ID`: wait until CI is green at the PR's head commit, then start
 * ONE reviewer agent for that head. The reviewer posts its own review comment
 * (`ORCH-REVIEW APPROVE|CHANGES <sha> by <agent>`, see mergegate.ts); watch then checks that a
 * line from that agent names the head. It never merges and never posts a review itself.
 *
 * - CI is read per commit (`gh api repos/R/commits/SHA/check-runs` and `.../status`), and
 *   ciAtHead() keeps only the rows whose sha is the head: a green run of an older commit never
 *   counts. No check at the head is not green: it is WAITING, unless [review.watch]
 *   require_ci = false says the repository has no CI. A pending or failed check: no dispatch.
 * - The reviewer comes from [review.agents.NAME] (cmd, vendor, account). chooseReviewer() drops
 *   every author agent (every holder of the task, as in the comments merge gate), grades the
 *   rest against the authors (cross-vendor, cross-account, single-agent in a fresh context) and
 *   takes the strongest, config order breaking ties. With a [profile], policy() for the PR's
 *   tier sets the strength needed; a best reviewer below it is BLOCKED, never a weaker dispatch.
 * - One dispatch per (PR, head), recorded in a state file under $ORCH_HOME. A new head gets a
 *   new dispatch; the same head never gets a second one unless --force. A reviewer that posts
 *   no line for the head within stale_minutes is STALE (and `orch doctor` lists it).
 *
 * A process gate between cooperating agents, like the comments merge gate: not a security
 * boundary. Accounts and vendors are declared, not verified.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError, configNumber, expand, orchHome } from "./config.js";
import { withLock } from "./lock.js";
import * as M from "./mergegate.js";
import * as P from "./profile.js";
import { dumps } from "./pyjson.js";
import { assertWriteOwnership, atomicWrite, isPlainObject, sleep, validName, which } from "./util.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CI_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CI_FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

// ---- CI at the head -----------------------------------------------------------------------------

/** One check run or status context, with the commit it reports on. */
export interface CheckRow {
  sha: string;
  name: string;
  /** conclusion when completed, else the run's status (QUEUED, IN_PROGRESS, PENDING, ...) */
  state: string;
}

export type CiState = "green" | "pending" | "failed" | "none";

/**
 * CI of one commit. Only rows whose sha IS the head count: rows for any other commit are
 * ignored, so a green older commit never makes a new head green. No row at the head = "none".
 */
export function ciAtHead(head: string, rows: CheckRow[]): { state: CiState; bad: string[] } {
  const at = rows.filter((r) => r.sha.toLowerCase() === head.toLowerCase());
  if (!at.length) return { state: "none", bad: [] };
  const failed = at.filter((r) => CI_FAILED.has(r.state.toUpperCase())).map((r) => `${r.name}=${r.state.toUpperCase()}`);
  if (failed.length) return { state: "failed", bad: failed };
  const pending = at.filter((r) => !CI_OK.has(r.state.toUpperCase())).map((r) => `${r.name}=${r.state.toUpperCase()}`);
  if (pending.length) return { state: "pending", bad: pending };
  return { state: "green", bad: [] };
}

// ---- configuration ------------------------------------------------------------------------------

export interface ReviewAgent {
  name: string;
  /** argv with {pr} {head} {repo} {agent} {prompt} placeholders, run without a shell */
  argv: string[] | null;
  /** a shell command line; the values arrive only as environment variables */
  shell: string | null;
  vendor: string | null;
  account: string | null;
}

export interface WatchSettings {
  requireCi: boolean;
  staleMinutes: number;
  pollSeconds: number;
  dir: string;
}

const AGENT_KEYS = ["cmd", "vendor", "account"];
const WATCH_KEYS = ["require_ci", "stale_minutes", "poll_seconds", "dir"];

/** [review.agents.NAME] tables, in config order. Throws ConfigError. */
export function readAgents(cfg: Record<string, any>): ReviewAgent[] {
  const raw = (cfg.review ?? {}).agents;
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw new ConfigError("[review.agents] must be a table of [review.agents.NAME] tables");
  const out: ReviewAgent[] = [];
  const seen = new Set<string>();
  for (const [name, t] of Object.entries(raw)) {
    if (!validName(name)) throw new ConfigError(`[review.agents] '${name}' is not a valid name: use letters, digits, . @ _ -`);
    if (seen.has(key(name))) throw new ConfigError(`[review.agents] two names differ only in case: '${name}'`);
    seen.add(key(name));
    if (!isPlainObject(t)) throw new ConfigError(`[review.agents.${name}] must be a table`);
    for (const k of Object.keys(t)) if (!AGENT_KEYS.includes(k)) throw new ConfigError(`[review.agents.${name}] unknown key '${k}' (known: ${AGENT_KEYS.join(", ")})`);
    const cmd = t.cmd;
    let argv: string[] | null = null;
    let shell: string | null = null;
    if (typeof cmd === "string" && cmd.trim()) shell = cmd;
    else if (Array.isArray(cmd) && cmd.length && cmd.every((x) => typeof x === "string") && cmd[0]) argv = cmd as string[];
    else throw new ConfigError(`[review.agents.${name}] cmd must be a command line or a non-empty array of strings (got ${JSON.stringify(cmd)})`);
    const opt = (k: string): string | null => {
      if (t[k] === undefined) return null;
      if (typeof t[k] !== "string" || !validName(t[k].trim())) throw new ConfigError(`[review.agents.${name}] ${k} must be a name (got ${JSON.stringify(t[k])})`);
      return t[k].trim();
    };
    const vendor = opt("vendor");
    out.push({ name, argv, shell, vendor: vendor === null ? null : P.vendorKey(vendor), account: opt("account") });
  }
  return out;
}

/** [review.watch]. Throws ConfigError. */
export function readSettings(cfg: Record<string, any>): WatchSettings {
  const w = (cfg.review ?? {}).watch ?? {};
  if (!isPlainObject(w)) throw new ConfigError("[review.watch] must be a table");
  for (const k of Object.keys(w)) if (!WATCH_KEYS.includes(k)) throw new ConfigError(`[review.watch] unknown key '${k}' (known: ${WATCH_KEYS.join(", ")})`);
  if (w.require_ci !== undefined && typeof w.require_ci !== "boolean") throw new ConfigError(`[review.watch] require_ci must be true or false (got ${JSON.stringify(w.require_ci)})`);
  if (w.dir !== undefined && (typeof w.dir !== "string" || !w.dir)) throw new ConfigError(`[review.watch] dir must be a path (got ${JSON.stringify(w.dir)})`);
  return {
    requireCi: w.require_ci ?? true,
    staleMinutes: configNumber(w.stale_minutes, 30, "[review.watch] stale_minutes", 1),
    pollSeconds: configNumber(w.poll_seconds, 60, "[review.watch] poll_seconds", 1),
    dir: w.dir ? expand(w.dir) : join(orchHome(), "review-watch"),
  };
}

// ---- choosing the reviewer ----------------------------------------------------------------------

/** Agent names compare case-insensitively (NFC), like task ids and review comments. */
function key(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export type Label = "cross-vendor" | "cross-account" | "single-agent (fresh context)" | "single-agent (unmapped)";
const LABELS: Label[] = ["single-agent (unmapped)", "single-agent (fresh context)", "cross-account", "cross-vendor"];

/** A label as the profile's review strength. */
export function strengthOf(l: Label): P.Achieved {
  return l === "single-agent (fresh context)" ? "single-agent" : l;
}

interface Where {
  account: string | null;
  vendor: string | null;
}

/** Account and vendor of an agent: [profile.agents] / [profile.accounts] first, then [review.agents.NAME]. */
function where(name: string, prof: P.Profile | null, agents: ReviewAgent[]): Where {
  const ra = agents.find((a) => key(a.name) === key(name));
  const pa = prof && Object.hasOwn(prof.agents, key(name)) ? prof.agents[key(name)] : null;
  const account = ra?.account ?? pa ?? null;
  const pv = prof && account && Object.hasOwn(prof.accounts, account) ? prof.accounts[account] : null;
  if (pv && ra?.vendor && ra.vendor !== pv) {
    throw new ConfigError(`[review.agents.${ra.name}] vendor = "${ra.vendor}", but account '${account}' is on '${pv}' in [profile.accounts]`);
  }
  return { account, vendor: pv ?? ra?.vendor ?? null };
}

/** One reviewer against every author: the weakest pairing. Anything undeclared is unmapped. */
export function gradeReviewer(r: Where, authors: Where[]): Label {
  if (!authors.length) return "single-agent (unmapped)";
  let worst = LABELS.length - 1;
  for (const a of authors) {
    let g: Label;
    if (r.vendor && a.vendor && r.vendor !== a.vendor) g = "cross-vendor";
    else if (!r.account || !a.account) g = "single-agent (unmapped)";
    else if (r.account === a.account) g = "single-agent (fresh context)";
    else if (r.vendor && a.vendor) g = "cross-account";
    else g = "single-agent (unmapped)";
    worst = Math.min(worst, LABELS.indexOf(g));
  }
  return LABELS[worst];
}

export interface Candidate {
  name: string;
  label: Label;
  account: string | null;
  vendor: string | null;
  available: boolean;
}

export interface Choice {
  /** the reviewer to start, or null (see reason) */
  pick: Candidate | null;
  candidates: Candidate[];
  /** authors left out of the candidates */
  excluded: string[];
  tier: P.Tier | null;
  tierSource: string | null;
  cell: P.Cell | null;
  need: P.Strength | null;
  reason: string | null;
}

export interface ChooseInput {
  agents: ReviewAgent[];
  profile: P.Profile | null;
  /** every agent that has held the PR's task */
  authors: string[];
  tierFlag?: P.Tier | null;
  /** changed files (for [profile] high_paths), or null when unreadable */
  files?: string[] | null;
  /** is this command runnable here? */
  which: (cmd: string) => string | null;
}

/**
 * Pure: pick the reviewer. Authors are never candidates. Strongest label wins; ties go to the
 * first in config order. Under a [profile], a pick below the policy's needed strength is null.
 */
export function chooseReviewer(inp: ChooseInput): Choice {
  const authorKeys = new Set(inp.authors.map(key));
  const excluded = inp.agents.filter((a) => authorKeys.has(key(a.name))).map((a) => a.name);
  const authorsAt = inp.authors.map((n) => where(n, inp.profile, inp.agents));
  const candidates: Candidate[] = inp.agents
    .filter((a) => !authorKeys.has(key(a.name)))
    .map((a) => {
      const w = where(a.name, inp.profile, inp.agents);
      return { name: a.name, label: gradeReviewer(w, authorsAt), ...w, available: a.shell !== null || inp.which(a.argv![0]) !== null };
    });
  const res: Choice = { pick: null, candidates, excluded, tier: null, tierSource: null, cell: null, need: null, reason: null };
  if (inp.profile) {
    const t = P.chooseTier(inp.profile, inp.tierFlag, inp.files === undefined ? [] : inp.files);
    const pol = P.policyFor(inp.profile, t.tier);
    Object.assign(res, { tier: t.tier, tierSource: t.source, cell: pol.cell, need: pol.needAgent });
  }
  const ready = candidates.filter((c) => c.available);
  if (!inp.agents.length) {
    res.reason = "no reviewer configured: add a [review.agents.NAME] table with cmd (and vendor, account)";
    return res;
  }
  if (!ready.length) {
    res.reason = candidates.length
      ? `no reviewer command found on PATH (${candidates.map((c) => c.name).join(", ")})`
      : `every configured reviewer is an author of this PR (${excluded.join(", ")}); add a reviewer that did not work on it`;
    return res;
  }
  let best = ready[0];
  for (const c of ready) if (LABELS.indexOf(c.label) > LABELS.indexOf(best.label)) best = c;
  if (res.need && !P.meets(strengthOf(best.label), res.need)) {
    res.reason = `the strongest available reviewer, ${best.name}, is ${best.label}; profile ${res.cell} at tier ${res.tier} needs ${res.need}. ` +
      "Add a reviewer on another " + (res.need === "cross-vendor" ? "vendor" : "account") + " to [review.agents]";
    return res;
  }
  res.pick = best;
  return res;
}

// ---- state --------------------------------------------------------------------------------------

export type Status = "dispatched" | "reviewed" | "stale";

export interface Rec {
  repo: string;
  pr: number;
  head: string;
  agent: string;
  label: Label;
  worker: string;
  pid: number | null;
  dispatched_at: number;
  stale_minutes: number;
  status: Status;
  verdict: string | null;
  /** earlier heads of this PR: {head, agent, status} */
  history: Record<string, any>[];
}

export function statePath(dir: string, repo: string, pr: number): string {
  return join(dir, `${repo.replace("/", "__")}__${pr}.json`);
}

export function readRec(path: string): Rec | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(v) && typeof v.head === "string" ? (v as Rec) : null;
  } catch {
    return null;
  }
}

/** Run fn under the lock of a state file (a sibling `<file>.lock.d`, as for every other store). */
function locked<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path + ".lock.d", fn);
}

function writeRec(path: string, rec: Rec): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, dumps(rec, 1) + "\n");
}

// ---- the host: everything that touches GitHub, processes or the clock ---------------------------

export interface DispatchSpec {
  worker: string;
  argv: string[];
  env: Record<string, string>;
  prompt: string;
  minutes: number;
}

export interface Host {
  /** unix seconds */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `gh pr view --json headRefOid,state,comments` (+ files,changedFiles,number when `files`) */
  pr(pr: number, repo: string, files: boolean): unknown;
  /** every check run and status context reported for commit `sha` */
  checks(repo: string, sha: string): CheckRow[];
  which(cmd: string): string | null;
  /** start the reviewer detached; returns its pid */
  dispatch(d: DispatchSpec): { pid: number | null };
}

function jsonLines(out: string): any[] {
  return out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

/** The real host: gh, the worker machinery of `orch worker`, the wall clock. */
export function realHost(start: (d: DispatchSpec) => { pid: number | null }): Host {
  const gh = (args: string[]) => {
    if (!which("gh")) throw new Error("review watch needs the GitHub CLI `gh`");
    return M.gh(args);
  };
  return {
    now: () => Date.now() / 1000,
    sleep,
    pr(pr, repo, files) {
      const info = JSON.parse(gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,state,comments" + (files ? ",files,changedFiles,number" : "")]));
      if (files && isPlainObject(info)) info.files = M.allFiles(repo, info.number);
      return info;
    },
    checks(repo, sha) {
      const runs = jsonLines(gh(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs`,
        "--jq", ".check_runs[] | [.head_sha, .name, (.conclusion // .status)] | @json"]));
      const statuses = jsonLines(gh(["api", "--paginate", `repos/${repo}/commits/${sha}/status`,
        "--jq", ".sha as $s | .statuses[] | [$s, .context, .state] | @json"]));
      return [...runs, ...statuses].map((r) => ({ sha: String(r[0] ?? ""), name: String(r[1] ?? "?"), state: String(r[2] ?? "") }));
    },
    which,
    dispatch: start,
  };
}

/** Tests replace the host here; null = the real one. */
export const override: { host: Host | null } = { host: null };

// ---- one pass -----------------------------------------------------------------------------------

export type Outcome = "WAITING" | "DISPATCHED" | "REVIEWED" | "STALE" | "BLOCKED" | "ERROR";
/** Outcomes that end `review watch` without --once. */
export const FINAL: Outcome[] = ["REVIEWED", "STALE", "BLOCKED"];

export interface WatchInput {
  pr: number;
  repo: string;
  authors: string[];
  agents: ReviewAgent[];
  profile: P.Profile | null;
  settings: WatchSettings;
  tierFlag?: P.Tier | null;
  dryRun?: boolean;
  force?: boolean;
}

export interface WatchResult {
  outcome: Outcome;
  pr: number;
  head: string | null;
  ci: CiState | null;
  detail: string;
  reviewer: Candidate | null;
  /** dry run: the command that would run */
  command: string[] | null;
  choice: Choice | null;
}

/** Substitute the placeholders of an argv command. */
export function commandFor(a: ReviewAgent, v: { pr: number; head: string; repo: string; prompt: string }): string[] {
  if (a.shell !== null) return ["/bin/sh", "-c", a.shell];
  return a.argv!.map((x) => x.replaceAll("{pr}", String(v.pr)).replaceAll("{head}", v.head).replaceAll("{repo}", v.repo)
    .replaceAll("{agent}", a.name).replaceAll("{prompt}", v.prompt));
}

/** The prompt file given to the reviewer (also on its stdin). */
export function promptText(pr: number, repo: string, head: string, c: Candidate, authors: string[]): string {
  return `# Review pull request #${pr} in ${repo}

You are the reviewer \`${c.name}\` for commit ${head} (the PR's head when you were started).
The PR was written by: ${authors.join(", ")}. Review strength of this pairing: ${c.label}.
${c.label === "single-agent (fresh context)" ? "You run on the author's account: review from a fresh context, without the author's notes or reasoning.\n" : ""}
1. Read the change at that commit: \`gh pr diff ${pr} --repo ${repo}\` and \`gh pr view ${pr} --repo ${repo}\`.
   If the PR's head is no longer ${head}, stop: a new reviewer is started for the new head.
2. Review it independently: correctness, tests, anything the description claims but the code does not do.
3. Post exactly one review comment for this commit, then stop:

       orch review approve ${pr} --as ${c.name} --head ${head} --repo ${repo} -m "why it is ready"
       orch review changes ${pr} --as ${c.name} --head ${head} --repo ${repo} -m "what must change"

   Its first line is \`ORCH-REVIEW APPROVE|CHANGES ${head} by ${c.name}\`.

Do not push, merge, close or edit the PR, and do not post a review for any other commit.
`;
}

/** Latest review comment by `agent` at `head` in the PR's comments: its verdict, or null. Also counts lines for other shas. */
export function postedLine(info: unknown, agent: string, head: string): { verdict: string | null; other: number } {
  let verdict: string | null = null;
  let other = 0;
  const comments = isPlainObject(info) && Array.isArray(info.comments) ? info.comments : [];
  for (const c of comments) {
    const body = isPlainObject(c) && typeof c.body === "string" ? c.body : "";
    const p = M.parseReviewLine(body);
    if (p === null || p === "malformed" || key(p.agent) !== key(agent)) continue;
    if (p.sha === head) verdict = p.verdict;
    else other += 1;
  }
  return { verdict, other };
}

function mins(s: number): string {
  return `${Math.max(0, Math.floor(s / 60))}m`;
}

/** One pass: read the PR, decide, dispatch at most once, record. Never merges. */
export function watchOnce(inp: WatchInput, host: Host): WatchResult {
  const res: WatchResult = { outcome: "BLOCKED", pr: inp.pr, head: null, ci: null, detail: "", reviewer: null, command: null, choice: null };
  const done = (outcome: Outcome, detail: string) => Object.assign(res, { outcome, detail });
  if (!REPO_RE.test(inp.repo)) return done("BLOCKED", inp.repo ? `bad repo '${inp.repo}': use owner/name` : "no repo: set [merge] repo in config.toml or pass --repo owner/name");
  if (!inp.authors.length) return done("BLOCKED", "the PR's task has no recorded holder, so its author is unknown; the author claims it with `orch task claim`");
  let info: unknown;
  try {
    info = host.pr(inp.pr, inp.repo, Boolean(inp.profile && inp.profile.high_paths.length));
  } catch (e: any) {
    return done("ERROR", `reading the PR failed: ${e.message ?? e}`);
  }
  const head = isPlainObject(info) && typeof info.headRefOid === "string" ? info.headRefOid.toLowerCase() : "";
  if (!SHA_RE.test(head)) return done("ERROR", `no usable head commit '${head}'`);
  res.head = head;
  const state = isPlainObject(info) && typeof info.state === "string" ? info.state.toUpperCase() : "";
  if (state && state !== "OPEN") return done("BLOCKED", `the PR is ${state.toLowerCase()}`);
  const path = statePath(inp.settings.dir, inp.repo, inp.pr);
  const now = host.now();

  // this head was dispatched before: follow that reviewer, never start a second one
  const prev = readRec(path);
  if (prev && prev.head === head && !inp.force) {
    res.reviewer = { name: prev.agent, label: prev.label, account: null, vendor: null, available: true };
    if (prev.status === "reviewed") return done("REVIEWED", `ORCH-REVIEW ${prev.verdict} ${head} by ${prev.agent} (${prev.label})`);
    if (prev.status === "stale") return done("STALE", `${prev.agent} posted no review line for ${head.slice(0, 9)} within ${prev.stale_minutes}m; \`--force\` starts another reviewer`);
    const posted = postedLine(info, prev.agent, head);
    if (posted.verdict) {
      if (!inp.dryRun) locked(path, () => writeRec(path, { ...prev, status: "reviewed", verdict: posted.verdict }));
      return done("REVIEWED", `ORCH-REVIEW ${posted.verdict} ${head} by ${prev.agent} (${prev.label})`);
    }
    const age = now - prev.dispatched_at;
    if (age >= prev.stale_minutes * 60) {
      if (!inp.dryRun) locked(path, () => writeRec(path, { ...prev, status: "stale" }));
      return done("STALE", `${prev.agent} posted no review line for ${head.slice(0, 9)} within ${prev.stale_minutes}m; \`--force\` starts another reviewer`);
    }
    return done("DISPATCHED", `${prev.agent} (${prev.label}) started ${mins(age)} ago; waiting for its review line (stale after ${prev.stale_minutes}m)` +
      (posted.other ? `; ${posted.other} line(s) by ${prev.agent} name another commit and do not count` : ""));
  }

  let choice: Choice;
  try {
    choice = chooseReviewer({
      agents: inp.agents, profile: inp.profile, authors: inp.authors, tierFlag: inp.tierFlag,
      files: inp.profile && inp.profile.high_paths.length ? M.changedFiles(info) : [], which: host.which,
    });
  } catch (e: any) {
    if (e instanceof ConfigError) throw e;
    return done("ERROR", String(e.message ?? e));
  }
  res.choice = choice;
  if (!choice.pick) return done("BLOCKED", choice.reason ?? "no reviewer");
  const pick = choice.pick;
  res.reviewer = pick;
  const agent = inp.agents.find((a) => a.name === pick.name)!;
  const worker = `review-${inp.pr}-${head.slice(0, 12)}`;
  const prompt = join(inp.settings.dir, `${worker}.prompt.md`);
  const argv = commandFor(agent, { pr: inp.pr, head, repo: inp.repo, prompt });
  if (inp.dryRun) res.command = argv;

  let rows: CheckRow[];
  try {
    rows = host.checks(inp.repo, head);
  } catch (e: any) {
    return done("ERROR", `reading CI failed: ${e.message ?? e}`);
  }
  const ci = ciAtHead(head, rows);
  res.ci = ci.state;
  if (ci.state === "pending") return done("WAITING", `CI pending at the head: ${ci.bad.join(", ")}`);
  if (ci.state === "failed") return done("WAITING", `CI failed at the head: ${ci.bad.join(", ")}; no review until a new head or a re-run is green`);
  if (ci.state === "none" && inp.settings.requireCi) {
    return done("WAITING", "no CI check reported at the head yet; if this repository has no CI, set [review.watch] require_ci = false");
  }
  const note = prev && prev.head !== head ? `; replaces ${prev.agent} at ${prev.head.slice(0, 9)} (head moved)` : prev && inp.force ? `; --force: replaces ${prev.agent} (${prev.status})` : "";
  if (inp.dryRun) return done("DISPATCHED", `dry run: would start ${pick.name} (${pick.label}); nothing was run${note}`);

  return locked(path, () => {
    // re-read under the lock: another `review watch` may have dispatched this head meanwhile
    const again = readRec(path);
    if (again && again.head === head && !inp.force) return done("DISPATCHED", `${again.agent} (${again.label}) was started for this head by another watcher`);
    assertWriteOwnership();
    mkdirSync(inp.settings.dir, { recursive: true });
    assertWriteOwnership();
    writeFileSync(prompt, promptText(inp.pr, inp.repo, head, pick, inp.authors));
    const env = { ORCH_AGENT: pick.name, ORCH_REVIEW_PR: String(inp.pr), ORCH_REVIEW_HEAD: head, ORCH_REVIEW_REPO: inp.repo, ORCH_REVIEW_PROMPT: prompt };
    let pid: number | null;
    try {
      assertWriteOwnership();
      pid = host.dispatch({ worker, argv, env, prompt, minutes: inp.settings.staleMinutes }).pid;
    } catch (e: any) {
      return done("BLOCKED", `starting ${pick.name} failed: ${e.message ?? e}`);
    }
    const history = [...(again?.history ?? []), ...(again ? [{ head: again.head, agent: again.agent, status: again.status }] : [])];
    writeRec(path, {
      repo: inp.repo, pr: inp.pr, head, agent: pick.name, label: pick.label, worker, pid, dispatched_at: now,
      stale_minutes: inp.settings.staleMinutes, status: "dispatched", verdict: null, history,
    });
    return done("DISPATCHED", `started ${pick.name} (${pick.label}) as worker ${worker}${note}`);
  });
}

/** The status line. */
export function renderResult(r: WatchResult): string {
  const head = r.head ? ` head=${r.head.slice(0, 9)}` : "";
  const ci = r.ci ? ` ci=${r.ci}` : "";
  let s = `#${r.pr}${head}${ci} => ${r.outcome} (${r.detail})`;
  if (r.command) {
    s += `\nreviewer: ${r.reviewer!.name} ${r.reviewer!.label}` + (r.reviewer!.vendor ? ` vendor=${r.reviewer!.vendor}` : "") + (r.reviewer!.account ? ` account=${r.reviewer!.account}` : "");
    s += `\ncommand: ${dumps(r.command)}`;
  }
  return s;
}

/** Repeat watchOnce until a final outcome or the timeout; emits each result whose status line changed. */
export async function watchLoop(inp: WatchInput, host: Host, emit: (r: WatchResult) => void, opts: { intervalS: number; timeoutS: number | null }): Promise<WatchResult> {
  const start = host.now();
  let last = "";
  for (;;) {
    const r = watchOnce(inp, host);
    const line = renderResult(r);
    if (line !== last) emit(r);
    last = line;
    if (FINAL.includes(r.outcome)) return r;
    if (opts.timeoutS !== null && host.now() - start + opts.intervalS > opts.timeoutS) return r;
    await host.sleep(opts.intervalS * 1000);
  }
}

// ---- doctor ------------------------------------------------------------------------------------

/**
 * Doctor rows, only when [review.agents] or a watch state directory exists: one per reviewer
 * command, one per reviewer that went stale (or is past its time and not yet re-checked).
 */
export function doctorRows(cfg: Record<string, any>, now: number): [boolean, string, string][] {
  const rows: [boolean, string, string][] = [];
  const agents = readAgents(cfg);
  const st = readSettings(cfg);
  for (const a of agents) {
    const bin = a.shell !== null ? "/bin/sh" : a.argv![0];
    const found = which(bin);
    rows.push([found !== null, `review agent ${a.name}`, found ? `${found}${a.vendor ? ` (${a.vendor}` + (a.account ? `, ${a.account})` : ")") : ""}` : `'${bin}' not on PATH`]);
  }
  if (!existsSync(st.dir)) return rows;
  for (const f of readdirSync(st.dir).filter((x) => x.endsWith(".json")).sort()) {
    const r = readRec(join(st.dir, f));
    if (!r) continue;
    const late = r.status === "stale" || (r.status === "dispatched" && now - r.dispatched_at >= r.stale_minutes * 60);
    if (late) rows.push([false, `review watch ${r.repo}#${r.pr}`, `${r.agent} posted no review line for ${String(r.head).slice(0, 9)} within ${r.stale_minutes}m (worker ${r.worker}); \`orch review watch ${r.pr} --force\` starts another`]);
  }
  return rows;
}
