// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Merge gate on GitHub-native reviews, bound to the pull request's live head commit.
 *
 * A PR passes only when ALL of these hold:
 *   1. CI: at least one check, and every check concluded SUCCESS, NEUTRAL or SKIPPED;
 *   2. approvals: at least `requiredApprovals` reviewers (not the PR author) whose latest
 *      decisive review is APPROVED *for the current head commit*;
 *   3. no reviewer's latest decisive review is CHANGES_REQUESTED;
 *   4. optional: the PR carries `requiredLabel` (empty = not required, the default).
 * A decisive review is APPROVED, CHANGES_REQUESTED or DISMISSED (DISMISSED clears the earlier
 * one); COMMENTED reviews are ignored. An approval of an older commit is stale and does not
 * count. Any error while fetching or reading the PR fails closed.
 *
 * Review source "comments" (`--reviews comments`, `[review] source`) is for teams whose agents
 * all share one code-host account, so no agent can approve on GitHub. Rule 2 and 3 then read
 * review comments: PR comments whose FIRST line is exactly
 *     ORCH-REVIEW APPROVE|CHANGES|REJECT <40-char head sha> by <agent>
 * A review comment counts only for the current head sha, and only when <agent> is not one of the
 * task's author agents (every holder in the task store; never the GitHub login). Per agent the latest review comment
 * counts; CHANGES and REJECT block. GitHub CHANGES_REQUESTED reviews still block; GitHub
 * approvals do not count. This is a process gate between cooperating agents, not a security
 * boundary: anyone holding the account's token can post a review comment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dumps } from "./pyjson.js";
import { isPlainObject, validName, which } from "./util.js";

const SHA_RE = /^[0-9a-f]{40}$/;
/** gh output limit. Node's 1 MiB default is too small for long comment threads (ENOBUFS = BLOCKED forever). */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;
const CI_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Malformed PR data (wrong JSON shapes): the CLI reports it as BLOCKED. */
export class PrDataError extends TypeError {}

function str(v: unknown, what: string): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") throw new PrDataError(`${what} is not a string`);
  return v;
}

function obj(v: unknown, what: string): Record<string, any> {
  if (v === undefined || v === null || v === "" || v === false || v === 0) return {};
  if (!isPlainObject(v)) throw new PrDataError(`${what} is not an object`);
  return v;
}

function list(v: unknown, what: string): any[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new PrDataError(`${what} is not a list`);
  return v;
}

function login(x: unknown): string {
  return str(obj(x, "author").login, "login").toLowerCase();
}

export type ReviewSource = "github" | "comments";
export const REVIEW_SOURCES: ReviewSource[] = ["github", "comments"];
export type Verdict = "APPROVE" | "CHANGES" | "REJECT";
export const VERDICTS: Verdict[] = ["APPROVE", "CHANGES", "REJECT"];
export const REVIEW_PREFIX = "ORCH-REVIEW";
const REVIEW_RE = /^ORCH-REVIEW (APPROVE|CHANGES|REJECT) ([0-9a-f]{40}) by (\S+)$/;

export interface ReviewLine {
  verdict: Verdict;
  sha: string;
  agent: string;
}

/** The first line of a review comment. Throws RangeError on a bad sha or agent name. */
export function reviewLine(verdict: Verdict, sha: string, agent: string): string {
  if (!VERDICTS.includes(verdict)) throw new RangeError(`bad verdict '${verdict}'`);
  if (!SHA_RE.test(sha)) throw new RangeError(`head must be the full 40-character commit sha, got '${sha}'`);
  if (!validName(agent)) throw new RangeError(`bad agent name '${agent}': use letters, digits, . @ _ -`);
  return `${REVIEW_PREFIX} ${verdict} ${sha} by ${agent}`;
}

/**
 * Read a comment body. null = not a review comment (first line, after leading spaces, does not
 * start with ORCH-REVIEW in any case); "malformed" = looks like one but is not exactly an
 * ORCH-REVIEW line (e.g. lower case, a leading space): shown, never counted. Only the first line
 * is read; trailing whitespace on it is ignored.
 */
export function parseReviewLine(body: string): ReviewLine | "malformed" | null {
  const first = body.split("\n", 1)[0].replace(/\s+$/, "");
  if (!first.trimStart().toUpperCase().startsWith(REVIEW_PREFIX)) return null;
  const m = REVIEW_RE.exec(first);
  if (!m || !validName(m[3])) return "malformed";
  return { verdict: m[1] as Verdict, sha: m[2], agent: m[3] };
}

/** Agent names compare case-insensitively (NFC), like task ids. */
function agentKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export interface GateOptions {
  requiredApprovals?: number;
  requiredLabel?: string;
  head?: string | null;
  /** "github" (default): GitHub reviews. "comments": ORCH-REVIEW lines in PR comments. */
  reviewSource?: ReviewSource;
  /** comments mode: the task's author agent(s); their review comments never count. */
  authorAgents?: string[];
}

export function evaluate(info: unknown, opts: GateOptions = {}): Record<string, any> {
  const pr = obj(info, "PR data");
  const need = Math.max(1, Math.trunc(Number(opts.requiredApprovals ?? 1)));
  if (Number.isNaN(need)) throw new PrDataError("required approvals is not a number");
  const requiredLabel = opts.requiredLabel ?? "";
  const live = str(pr.headRefOid, "headRefOid").toLowerCase();
  const res: Record<string, any> = { head: live.slice(0, 9), ok: false, need };
  if (!SHA_RE.test(live)) {
    res.reason = `no usable head commit '${live}'`;
    return res;
  }
  if (opts.head && !live.startsWith(opts.head.toLowerCase())) {
    // --head is an expected-head guard: the PR moved since the caller looked
    res.reason = `head moved: expected ${opts.head.slice(0, 9)}, PR is at ${live.slice(0, 9)}`;
    return res;
  }
  const head = live;
  if ((opts.reviewSource ?? "github") === "comments") return evaluateComments(pr, res, head, need, requiredLabel, opts.authorAgents ?? []);
  const { latest, self: selfReviews } = latestReviews(pr);
  let approvals = 0;
  let stale = 0;
  let blocking = 0;
  for (const rv of latest.values()) {
    const state = String(rv.state).toUpperCase();
    if (state === "CHANGES_REQUESTED") blocking += 1;
    else if (state === "APPROVED") {
      const oid = str(obj(rv.commit, "review commit").oid, "commit oid").toLowerCase();
      if (oid === head) approvals += 1;
      else stale += 1;
    }
  }
  const { ciOk, checks, labelOk } = ciAndLabel(pr, requiredLabel);
  const ok = ciOk && labelOk && approvals >= need && blocking === 0;
  Object.assign(res, {
    ok, ci_ok: ciOk, checks, label: requiredLabel, label_ok: labelOk,
    approvals, stale, self: selfReviews, changes_requested: blocking,
  });
  return res;
}

/** Per non-author reviewer login, the latest decisive GitHub review; `self` counts the author's own. */
function latestReviews(pr: Record<string, any>): { latest: Map<string, Record<string, any>>; self: number } {
  const author = login(pr.author);
  const latest = new Map<string, Record<string, any>>(); // reviewer -> latest decisive review
  let self = 0;
  for (const rvRaw of list(pr.reviews, "reviews")) {
    const rv = obj(rvRaw, "review");
    const who = login(rv.author);
    const state = str(rv.state, "review state").toUpperCase();
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state) || !who) continue;
    if (who === author) {
      self += 1;
      continue;
    }
    latest.set(who, rv);
  }
  return { latest, self };
}

/** Profiles: GitHub logins (lower case, sorted) whose latest decisive review is APPROVED at the head. */
export function githubApprovedAtHead(info: unknown): string[] {
  const pr = obj(info, "PR data");
  const head = str(pr.headRefOid, "headRefOid").toLowerCase();
  return [...latestReviews(pr).latest.entries()]
    .filter(([, rv]) => String(rv.state).toUpperCase() === "APPROVED" && str(obj(rv.commit, "review commit").oid, "commit oid").toLowerCase() === head)
    .map(([who]) => who).sort();
}

/** Profiles: the PR author's login, lower case. */
export function prAuthor(info: unknown): string {
  return login(obj(info, "PR data").author);
}

/** Profiles: the changed file paths (`gh pr view --json files`), or null when they cannot be read. */
export function changedFiles(info: unknown): string[] | null {
  const f = isPlainObject(info) ? info.files : undefined;
  if (!Array.isArray(f)) return null;
  const paths = f.map((x) => (isPlainObject(x) && typeof x.path === "string" ? x.path : null));
  return paths.some((x) => x === null) ? null : (paths as string[]);
}

function ciAndLabel(pr: Record<string, any>, requiredLabel: string) {
  const rollup: [string, string][] = list(pr.statusCheckRollup, "statusCheckRollup").map((cRaw) => {
    const c = obj(cRaw, "check");
    const wf = str(c.workflowName, "workflowName");
    const name = str(c.name, "check name") || str(c.context, "check context") || "?";
    const concl = (str(c.conclusion, "conclusion") || str(c.state, "check state")).toUpperCase();
    return [(wf ? wf + "/" : "") + name, concl];
  });
  const ciOk = rollup.length > 0 && rollup.every(([, v]) => CI_OK.has(v)); // every entry, duplicates included
  const bad = rollup.filter(([, v]) => !CI_OK.has(v));
  const checks: Record<string, string> = {};
  for (const [k, v] of bad.length ? bad : rollup) checks[k] = v;
  const labels = list(pr.labels, "labels").map((l) => obj(l, "label").name);
  const labelOk = !requiredLabel || labels.includes(requiredLabel);
  return { ciOk, checks, labelOk };
}

/** Review source "comments": approvals and blocks come from ORCH-REVIEW comments. */
function evaluateComments(pr: Record<string, any>, res: Record<string, any>, head: string, need: number,
  requiredLabel: string, authorAgents: string[]): Record<string, any> {
  const authors = [...new Set(authorAgents.filter((a) => typeof a === "string" && a).map(agentKey))];
  res.reviews = "comments";
  if (!authors.length) {
    res.reason = "no author agent: comments mode needs the PR's task (--task ID) with a recorded holder";
    return res;
  }
  // GitHub CHANGES_REQUESTED from a non-author login still blocks (fail closed); approvals there do not count
  const ghBlocking = [...latestReviews(pr).latest.values()].filter((rv) => String(rv.state).toUpperCase() === "CHANGES_REQUESTED").length;
  const latest = new Map<string, ReviewLine>(); // agent -> latest review comment at the head, in comment order
  let stale = 0;
  let self = 0;
  let malformed = 0;
  for (const cRaw of list(pr.comments, "comments")) {
    const p = parseReviewLine(str(obj(cRaw, "comment").body, "comment body"));
    if (p === null) continue;
    if (p === "malformed") {
      malformed += 1;
      continue;
    }
    if (p.sha !== head) {
      stale += 1;
      continue;
    }
    const who = agentKey(p.agent);
    if (authors.includes(who)) {
      self += 1;
      continue;
    }
    latest.set(who, p);
  }
  const approvedBy = [...latest.entries()].filter(([, r]) => r.verdict === "APPROVE").map(([k]) => k).sort();
  const blockedBy = [...latest.entries()].filter(([, r]) => r.verdict !== "APPROVE").map(([k]) => k).sort();
  const blocking = blockedBy.length + ghBlocking;
  const { ciOk, checks, labelOk } = ciAndLabel(pr, requiredLabel);
  const ok = ciOk && labelOk && approvedBy.length >= need && blocking === 0;
  Object.assign(res, {
    ok, authors, ci_ok: ciOk, checks, label: requiredLabel, label_ok: labelOk,
    approvals: approvedBy.length, approved_by: approvedBy, stale, self, malformed,
    changes_requested: blocking, blocked_by: blockedBy, github_changes_requested: ghBlocking,
  });
  return res;
}

/**
 * The `gh pr view --json` field list. The github source is unchanged from v2.0; comments adds
 * `comments`; `files` is added only for a profile with path rules.
 */
export function liveFields(source: ReviewSource = "github", files = false): string {
  return "author,headRefOid,reviews,labels,statusCheckRollup" + (source === "comments" ? ",comments" : "") + (files ? ",files" : "");
}

export function fetchLive(pr: string, repo: string, source: ReviewSource = "github", files = false): unknown {
  if (!which("gh")) throw new Error("live mode needs the GitHub CLI `gh` (or use --fixture)");
  if (!repo) throw new Error("no repo: set [merge] repo in config.toml or pass --repo owner/name");
  const out = spawnSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json",
    liveFields(source, files)], { encoding: "utf8", timeout: 60_000, maxBuffer: GH_MAX_BUFFER });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error((out.stderr || "").trim() || "gh pr view failed");
  return JSON.parse(out.stdout);
}

function gh(args: string[]): string {
  const out = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: GH_MAX_BUFFER });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error((out.stderr || "").trim() || `gh ${args[0]} ${args[1]} failed`);
  return out.stdout;
}

/** The PR's live head sha, for `orch review` when --head is not given. */
export function fetchHead(pr: string, repo: string): string {
  if (!which("gh")) throw new Error("posting a review comment needs the GitHub CLI `gh`");
  if (!repo) throw new Error("no repo: set [merge] repo in config.toml or pass --repo owner/name");
  const head = str(obj(JSON.parse(gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"])), "PR data").headRefOid, "headRefOid").toLowerCase();
  if (!SHA_RE.test(head)) throw new Error(`no usable head commit '${head}'`);
  return head;
}

/** Post a PR comment through `gh pr comment` (no shell; the body is one argument). */
export function postComment(pr: string, repo: string, body: string): void {
  if (!which("gh")) throw new Error("posting a review comment needs the GitHub CLI `gh`");
  if (!repo) throw new Error("no repo: set [merge] repo in config.toml or pass --repo owner/name");
  gh(["pr", "comment", String(pr), "--repo", repo, "--body", body]);
}

export function loadFixture(name: string): unknown {
  let p = name;
  if (!existsSync(p)) p = FIXTURE_DIR + `${name}.json`;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function fixtureNames(): string[] {
  try {
    return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/**
 * The text verdict. `profileLines`, when given, is [strength line, verdict line] from a profile
 * (profile.ts); without it the output is the plain gate's, byte for byte.
 */
export function render(pr: string, r: Record<string, any>, profileLines?: [string, string]): string {
  if (!("checks" in r)) return `#${pr} => BLOCKED (${r.reason})`;
  if (profileLines) return render(pr, r).replace(/\n=> (PASS|BLOCKED)$/, "\n" + profileLines.join("\n"));
  const ci = r.ci_ok ? "green" : "NOT green " + dumps(r.checks);
  const label = !r.label ? "off" : r.label_ok ? r.label : `MISSING '${r.label}'`;
  if (r.reviews === "comments") {
    return `#${pr} head=${r.head} ci=${ci} reviews=comments author=${r.authors.join(",")} approvals=${r.approvals}/${r.need}` +
      (r.approved_by.length ? ` [${r.approved_by.join(",")}]` : "") +
      ` (stale=${r.stale} self=${r.self} malformed=${r.malformed}) changes_requested=${r.changes_requested}` +
      (r.blocked_by.length ? ` [${r.blocked_by.join(",")}]` : "") + ` label=${label}\n` +
      `=> ${r.ok ? "PASS" : "BLOCKED"}`;
  }
  return `#${pr} head=${r.head} ci=${ci} approvals=${r.approvals}/${r.need} ` +
    `(stale=${r.stale} self=${r.self}) changes_requested=${r.changes_requested} label=${label}\n` +
    `=> ${r.ok ? "PASS" : "BLOCKED"}`;
}
