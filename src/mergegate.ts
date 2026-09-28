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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dumps } from "./pyjson.js";
import { isPlainObject, which } from "./util.js";

const SHA_RE = /^[0-9a-f]{40}$/;
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

export interface GateOptions {
  requiredApprovals?: number;
  requiredLabel?: string;
  head?: string | null;
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
  const author = login(pr.author);
  const latest = new Map<string, Record<string, any>>(); // reviewer -> latest decisive review
  let selfReviews = 0;
  for (const rvRaw of list(pr.reviews, "reviews")) {
    const rv = obj(rvRaw, "review");
    const who = login(rv.author);
    const state = str(rv.state, "review state").toUpperCase();
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state) || !who) continue;
    if (who === author) {
      selfReviews += 1;
      continue;
    }
    latest.set(who, rv);
  }
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
  const ok = ciOk && labelOk && approvals >= need && blocking === 0;
  Object.assign(res, {
    ok, ci_ok: ciOk, checks, label: requiredLabel, label_ok: labelOk,
    approvals, stale, self: selfReviews, changes_requested: blocking,
  });
  return res;
}

export function fetchLive(pr: string, repo: string): unknown {
  if (!which("gh")) throw new Error("live mode needs the GitHub CLI `gh` (or use --fixture)");
  if (!repo) throw new Error("no repo: set [merge] repo in config.toml or pass --repo owner/name");
  const out = spawnSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json",
    "author,headRefOid,reviews,labels,statusCheckRollup"], { encoding: "utf8", timeout: 60_000 });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error((out.stderr || "").trim() || "gh pr view failed");
  return JSON.parse(out.stdout);
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

export function render(pr: string, r: Record<string, any>): string {
  if (!("checks" in r)) return `#${pr} => BLOCKED (${r.reason})`;
  const ci = r.ci_ok ? "green" : "NOT green " + dumps(r.checks);
  const label = !r.label ? "off" : r.label_ok ? r.label : `MISSING '${r.label}'`;
  return `#${pr} head=${r.head} ci=${ci} approvals=${r.approvals}/${r.need} ` +
    `(stale=${r.stale} self=${r.self}) changes_requested=${r.changes_requested} label=${label}\n` +
    `=> ${r.ok ? "PASS" : "BLOCKED"}`;
}
