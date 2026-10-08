// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Profiles (docs/profiles.md): the [profile] tables of config.toml hold declared review context
 * (accounts, vendors, people) and ONE explicitly selected policy, "human-merge": a non-author
 * agent review of the PR's head at or above `required_review`, a listed teammate's approval on a
 * high-tier PR of a team profile, and a person performing every merge. gateProfile() grades the
 * approvals the plain gate already counted and reports the review strength achieved.
 *
 * Nothing is derived from the number of accounts or vendors: the review strength needed and the
 * worker limit are the values written in the table. A [profile] written for the built-in
 * compute x people table of an earlier source version (no `policy` key) is refused with a migration
 * message; it is never mapped to another rule.
 *
 * Fail closed: an unknown account or vendor grades as single-agent, a needed strength the setup
 * cannot give is BLOCKED, and no merge authority is automatic. Accounts and vendors are declared,
 * not verified: a process gate between cooperating agents, not a security boundary. With no
 * [profile] table none of this code runs.
 */
import { ConfigError } from "./config.js";
import { ASSIGNMENTS, type Assignment, replaceTables, tableRanges, tomlKey, tomlValue } from "./toml.js";
import { isPlainObject, validName } from "./util.js";

/** Declared review context: how many agent accounts, and on how many agent CLIs. Selects no rule. */
export type Compute = "one" | "same-vendor" | "multi-vendor";
export type People = "solo" | "team";
export type Tier = "low" | "high";
/** Ordered, weakest first. A label computed from declared accounts and vendors, not a measured quality. */
export type Strength = "single-agent" | "cross-account" | "cross-vendor";
/** Who performs the merge once the gate passes. Always a person. */
export type Authority = "owner" | "teammate";
/** The policies a [profile] can select. One public example; a profile names it explicitly. */
export type PolicyName = "human-merge";

export const COMPUTES: Compute[] = ["one", "same-vendor", "multi-vendor"];
export const PEOPLE: People[] = ["solo", "team"];
export const TIERS: Tier[] = ["low", "high"];
export const STRENGTHS: Strength[] = ["single-agent", "cross-account", "cross-vendor"];
export const POLICIES: PolicyName[] = ["human-merge"];

/**
 * The three values a person gives before a profile is written: the policy (which fixes who may
 * merge), the review requirement and the worker limit. None has a default anywhere in orch.
 */
export interface Selection {
  policy: PolicyName;
  required_review: Strength;
  max_workers: number;
}
/** The flags that carry a Selection, as the messages name them. */
export const SELECT_FLAGS = "--policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N";

export interface Policy {
  name: PolicyName;
  /** weakest agent review that satisfies the rule: [profile] required_review */
  needAgent: Strength;
  /** a teammate's GitHub approval at the head is also required */
  needTeammate: boolean;
  /** who performs the merge once the gate passes */
  authority: Authority;
  /** most workers running at once: [profile] max_workers */
  workerCap: number;
}

// ---- the [profile] tables ---------------------------------------------------------------------

export interface Profile {
  policy: PolicyName;
  compute: Compute;
  people: People;
  lead_account: string | null;
  required_review: Strength;
  default_tier: Tier;
  high_paths: string[];
  teammates: string[];
  max_workers: number;
  /** account id -> vendor (agent CLI name) */
  accounts: Record<string, string>;
  /** agent name (lower case) -> account id */
  agents: Record<string, string>;
  /** the table as written, for `profile update` */
  raw: Record<string, any>;
}

const KEYS = ["policy", "compute", "people", "lead_account", "required_review", "default_tier", "high_paths", "teammates", "max_workers", "accounts", "agents"];

/** What to write instead of a profile that relied on the removed built-in table. */
export const MIGRATION_HELP = 'set policy = "human-merge", required_review = "single-agent" | "cross-account" | "cross-vendor" and max_workers = N (N >= 1) in [profile], ' +
  "for example `orch profile update --policy human-merge --required-review cross-account --max-workers 2`; a person performs every merge under this policy (docs/profiles.md)";

function bad(msg: string): never {
  throw new ConfigError(msg);
}

function strList(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) bad(`[profile] ${key} must be an array of non-empty strings (got ${JSON.stringify(v)})`);
  return v as string[];
}

/** [profile] max_workers: chosen by the operator, never derived. Missing, 0 or negative is refused. */
function workerLimit(v: unknown): number {
  if (v === undefined) bad("[profile] max_workers is required: the most workers running at once, an integer >= 1 that you choose (it is not derived from the number of accounts)");
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    bad(`[profile] max_workers must be an integer >= 1 (got ${JSON.stringify(v)}); 0 meant "derived from the number of accounts" in an earlier source version, and that derivation is removed`);
  }
  return v as number;
}

/**
 * A [profile] written for the removed compute x people table: refused, with what to set instead.
 * It is not mapped to the public policy, because that could require less than the old table did.
 */
function refuseLegacy(raw: Record<string, any>): void {
  if (raw.policy === undefined) {
    bad("[profile] has no policy key: it was written for the built-in compute x people table that an earlier orch-os source version carried, which is removed. " +
      `No rule is chosen for you and none is applied; ${MIGRATION_HELP}`);
  }
  if (raw.workers_per_account !== undefined) {
    bad("[profile] workers_per_account is not supported: the worker limit is not derived from the number of accounts. " +
      "Remove the key and set max_workers = N (N >= 1); `orch profile update --max-workers N` does both");
  }
}

function oneOf<T extends string>(v: unknown, allowed: T[], key: string, dflt?: T): T {
  if (v === undefined && dflt !== undefined) return dflt;
  if (v === undefined) bad(`[profile] ${key} is required: ${allowed.map((x) => `"${x}"`).join(", ")}`);
  if (!(allowed as unknown[]).includes(v)) bad(`[profile] ${key} must be ${allowed.map((x) => `"${x}"`).join(" or ")} (got ${JSON.stringify(v)})`);
  return v as T;
}

/** `lower`: values are compared case-insensitively (vendor names), so they are trimmed and lower-cased. */
function nameMap(v: unknown, table: string, what: string, lower = false): Record<string, string> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) bad(`[${table}] must be a table`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!validName(k)) bad(`[${table}] '${k}' is not a valid name: use letters, digits, . @ _ -`);
    const val = typeof x === "string" && lower ? vendorKey(x) : x;
    if (typeof val !== "string" || !validName(val)) bad(`[${table}] ${k} must be ${what} (got ${JSON.stringify(x)})`);
    out[k] = val;
  }
  return out;
}

/** Vendor names compare trimmed and case-insensitively: "Claude" and "claude" are one vendor. */
export function vendorKey(v: string): string {
  return v.trim().normalize("NFC").toLowerCase();
}

/**
 * high_paths globs are repository-relative: a leading "/" (a CODEOWNERS or gitignore habit) is
 * dropped, so "/migrations/**" means "migrations/**". A glob that is empty after that is an error.
 */
function globList(v: unknown): string[] {
  return strList(v, "high_paths").map((g) => {
    const s = g.replace(/^\/+/, "");
    if (!s) bad(`[profile] high_paths: '${g}' matches no file`);
    return s;
  });
}

/**
 * The profile must be written as [profile], [profile.accounts] and [profile.agents] tables with
 * plain keys: no dotted keys, no inline tables, nothing under another table. Only that form can
 * be rewritten in place by `profile update`. Checked when the config came from parseToml.
 */
export function checkForm(cfg: Record<string, any>): void {
  const form: Assignment[] | undefined = (cfg as any)[ASSIGNMENTS];
  if (!form) return;
  for (const a of form) {
    const path = [...a.table, ...a.key];
    if (path[0] !== "profile") continue;
    const shown = path.join(".");
    if (a.table[0] !== "profile") bad(`[profile] must be written as [profile] tables; found '${shown}' under ${a.table.length ? `[${a.table.join(".")}]` : "the top level"}`);
    if (a.key.length > 1) bad(`[profile] must be written with plain keys; found the dotted key '${a.key.join(".")}' in [${a.table.join(".")}] (use a [${[...a.table, ...a.key.slice(0, -1)].join(".")}] table)`);
    if (a.inline) bad(`[profile] must be written without inline tables; found '${shown}' (use a [${shown}] table)`);
  }
}

/** The validated profile, or null when config.toml has no [profile] table. Throws ConfigError. */
export function readProfile(cfg: Record<string, any>): Profile | null {
  const raw = cfg.profile;
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) bad("[profile] must be a table");
  checkForm(cfg);
  refuseLegacy(raw);
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad(`[profile] unknown key '${k}' (known: ${KEYS.join(", ")})`);
  const accounts = nameMap(raw.accounts, "profile.accounts", "a vendor name, e.g. \"claude\"", true);
  const byName = nameMap(raw.agents, "profile.agents", "an account id");
  const agents: Record<string, string> = {};
  for (const [name, acct] of Object.entries(byName)) {
    if (!Object.hasOwn(accounts, acct)) bad(`[profile.agents] ${name} = "${acct}": '${acct}' is not an account in [profile.accounts]`);
    const key = name.normalize("NFC").toLowerCase();
    if (Object.hasOwn(agents, key)) bad(`[profile.agents] two names differ only in case: '${name}'`);
    agents[key] = acct;
  }
  let lead: string | null = null;
  if (raw.lead_account !== undefined) {
    if (typeof raw.lead_account !== "string" || !Object.hasOwn(accounts, raw.lead_account)) bad(`[profile] lead_account must be an account in [profile.accounts] (got ${JSON.stringify(raw.lead_account)})`);
    lead = raw.lead_account;
  } else if (Object.keys(accounts).length === 1) lead = Object.keys(accounts)[0];
  return {
    policy: oneOf(raw.policy, POLICIES, "policy"),
    compute: oneOf(raw.compute, COMPUTES, "compute"),
    people: oneOf(raw.people, PEOPLE, "people"),
    lead_account: lead,
    required_review: oneOf(raw.required_review, STRENGTHS, "required_review"),
    default_tier: oneOf(raw.default_tier, TIERS, "default_tier", "high"),
    high_paths: globList(raw.high_paths),
    teammates: strList(raw.teammates, "teammates"),
    max_workers: workerLimit(raw.max_workers),
    accounts, agents, raw,
  };
}

// ---- the policy -------------------------------------------------------------------------------

/**
 * Pure: the "human-merge" rule for one profile and tier. Every value is the one written in the
 * table: the review strength is `required_review` on both tiers and the worker limit is
 * `max_workers`. A team profile also needs a listed teammate's approval on the high tier.
 * Anything but "low" (a typo, a missing value) is the high tier. The declared `compute`, the
 * number of accounts and their vendors change nothing here: a strength the setup cannot give is
 * BLOCKED by the gate, not lowered.
 */
export function policyFor(p: Profile, tier: Tier): Policy {
  const needTeammate = p.people === "team" && tier !== "low";
  return { name: p.policy, needAgent: p.required_review, needTeammate, authority: needTeammate ? "teammate" : "owner", workerCap: p.max_workers };
}

// ---- grading ----------------------------------------------------------------------------------

export type Achieved = Strength | "single-agent (unmapped)" | "none";

function rank(a: Achieved): number {
  return a === "none" ? -1 : a === "single-agent (unmapped)" ? 0 : STRENGTHS.indexOf(a);
}

/** One approval: the weakest grade against every author. Unknown reviewer or author = unmapped. */
export function grade(p: Profile, reviewer: string, authors: string[]): Achieved {
  // own keys only: an agent named like an Object.prototype member ("constructor") is unmapped, never graded
  const acct = (n: string) => {
    const k = n.normalize("NFC").toLowerCase();
    return Object.hasOwn(p.agents, k) ? p.agents[k] : undefined;
  };
  const ra = acct(reviewer);
  if (!ra || !authors.length || authors.some((x) => !acct(x))) return "single-agent (unmapped)";
  let worst: Strength = "cross-vendor";
  for (const x of authors) {
    const aa = acct(x)!; // every author was checked above
    const g: Strength = aa === ra ? "single-agent" : p.accounts[aa] === p.accounts[ra] ? "cross-account" : "cross-vendor";
    if (STRENGTHS.indexOf(g) < STRENGTHS.indexOf(worst)) worst = g;
  }
  return worst;
}

/** The strongest grade among the counting approvals, or "none". */
export function achieved(p: Profile, approvers: string[], authors: string[]): Achieved {
  let best: Achieved = "none";
  for (const who of approvers) {
    const g = grade(p, who, authors);
    if (rank(g) > rank(best) || (g === "single-agent" && best === "single-agent (unmapped)")) best = g;
  }
  return best;
}

export function meets(a: Achieved, need: Strength): boolean {
  return a !== "none" && rank(a) >= STRENGTHS.indexOf(need);
}

// ---- tier -------------------------------------------------------------------------------------

/** A path glob: `*` and `?` stay inside one path segment, `**` crosses `/`. Anchored. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** --tier, then high_paths (raise only), then default_tier. files = null: the list was unreadable. */
export function chooseTier(p: Profile, flag: Tier | null | undefined, files: string[] | null): { tier: Tier; source: string } {
  if (flag) return { tier: flag, source: "flag" };
  if (p.high_paths.length) {
    if (files === null) return { tier: "high", source: "files unreadable" };
    const res = p.high_paths.map(globRe);
    const hit = files.find((f) => res.some((x) => x.test(f)));
    if (hit !== undefined) return { tier: "high", source: `path: ${hit}` };
  }
  return { tier: p.default_tier, source: "default" };
}

// ---- the gate ---------------------------------------------------------------------------------

export function isTeammate(p: Profile, login: string): boolean {
  return p.teammates.some((t) => t.toLowerCase() === login.toLowerCase());
}

export interface GateInput {
  tierFlag?: Tier | null;
  /** the caller would merge automatically on PASS: always a BLOCKED reason, no policy gives that authority */
  auto?: boolean;
  /** changed files, or null when unreadable */
  files: string[] | null;
  /** names of the agent approvals the plain gate counted (teammates already left out) */
  approvers: string[];
  /** the PR's author agent(s) */
  authors: string[];
  /** GitHub logins whose latest review is APPROVED at the head (never the PR author) */
  githubApproved: string[];
}

/** Grade a plain-gate result under the profile. Pure; `ok` is the profile's own verdict. */
export function gateProfile(p: Profile, g: GateInput): { ok: boolean; info: Record<string, any> } {
  const { tier, source } = chooseTier(p, g.tierFlag, g.files);
  const pol = policyFor(p, tier);
  const got = achieved(p, g.approvers, g.authors);
  const teammate = p.people === "solo" ? "n/a" : g.githubApproved.some((l) => isTeammate(p, l)) ? "approved" : "missing";
  const reasons: string[] = [];
  if (!meets(got, pol.needAgent)) reasons.push(`review strength ${got} is below ${pol.needAgent}`);
  if (pol.needTeammate && teammate !== "approved") {
    reasons.push(p.teammates.length ? "a teammate's approval at the head is required" : "no teammates listed in [profile] teammates");
  }
  if (g.auto) reasons.push(`--auto: policy ${pol.name} gives no automatic merge authority; a person performs the merge`);
  return {
    ok: reasons.length === 0,
    info: {
      policy: pol.name, tier, tier_source: source, achieved: got, needed: pol.needAgent,
      teammate, need_teammate: pol.needTeammate, authority: pol.authority, worker_cap: pol.workerCap, reasons,
    },
  };
}

/** The strength line printed between the summary and the verdict. */
export function strengthLine(i: Record<string, any>): string {
  return `profile=${i.policy} tier=${i.tier}(${i.tier_source}) review=${i.achieved} needed=${i.needed} ` +
    `teammate=${i.teammate} authority=${i.authority}`;
}

/** The verdict line under a profile. */
export function verdictLine(ok: boolean, i: Record<string, any>): string {
  const notes: string[] = [...i.reasons];
  if (ok && i.authority === "owner") notes.push(i.achieved.startsWith("single-agent") ? "single-agent review only; the owner decides the merge" : "the owner decides the merge");
  if (ok && i.authority === "teammate") notes.push("the teammate who approved, or the owner, performs the merge");
  return `=> ${ok ? "PASS" : "BLOCKED"}` + (notes.length ? ` (${notes.join("; ")})` : "");
}

// ---- capabilities (doctor rows, `profile show`) -------------------------------------------------

export interface Env {
  /** agent CLI names found by detection */
  found: string[];
  /** [agents.NAME] names in config.toml */
  configured: string[];
  gh: boolean;
  repo: string;
}

export type CapRow = [ok: boolean, name: string, detail: string];

function groupAccounts(p: Profile): string {
  const byVendor = new Map<string, string[]>();
  for (const [id, v] of Object.entries(p.accounts)) byVendor.set(v, [...(byVendor.get(v) ?? []), id]);
  return [...byVendor.entries()].map(([v, ids]) => `${ids.join(", ")} (${v})`).join(", ") || "none listed";
}

/** The selected policy and the declared context, for `init`, `profile show` and the doctor row. */
export function profileLabel(p: Profile): string {
  return `${p.policy} (${p.compute} · ${p.people})`;
}

/**
 * One row per profile check. ok=false means a missing capability (SKIP): never a FAIL. A missing
 * capability never lowers the rule: the row says what stays BLOCKED until it is added.
 */
export function capabilityRows(p: Profile, env: Env): CapRow[] {
  const rows: CapRow[] = [[true, "profile", `${profileLabel(p)}: accounts ${groupAccounts(p)}`]];
  const accts = Object.keys(p.accounts);
  const vendors = [...new Set(Object.values(p.accounts))];
  if (p.compute !== "one") {
    rows.push(accts.length >= 2 ? [true, "profile accounts", `${accts.length} accounts`]
      : [false, "profile accounts", `${p.compute} declared, but ${accts.length ? "only one account is" : "no account is"} listed in [profile.accounts]; ` +
        "no review can grade above single-agent until a second account is added"]);
  }
  if (p.compute === "multi-vendor" && accts.length >= 2) {
    rows.push(vendors.length >= 2 ? [true, "profile vendors", vendors.join(", ")]
      : [false, "profile vendors", `multi-vendor declared, but every account is on '${vendors[0]}'; no review can grade as cross-vendor until an account on another vendor is added`]);
  }
  for (const v of vendors) {
    const ids = accts.filter((a) => p.accounts[a] === v);
    const where = env.found.some((f) => vendorKey(f) === v) ? "CLI found" : env.configured.some((c) => vendorKey(c) === v) ? `[agents.${v}] configured` : "";
    rows.push(where ? [true, `profile vendor ${v}`, where]
      : [false, `profile vendor ${v}`, `${ids.length > 1 ? "accounts" : "account"} ${ids.join(", ")} ${ids.length > 1 ? "are" : "is"} on '${v}', ` +
        `but no ${v} CLI was found and no [agents.${v}] is configured`]);
  }
  if (p.people === "team") {
    rows.push(p.teammates.length ? [true, "profile teammates", p.teammates.join(", ")]
      : [false, "profile teammates", "people = team, but [profile] teammates is empty; high-tier PRs stay BLOCKED until a login is added"]);
    rows.push(env.gh && env.repo ? [true, "profile teammate reviews", `read from GitHub (${env.repo})`]
      : [false, "profile teammate reviews", "teammate approvals are read from GitHub; gh is absent or [merge] repo is unset"]);
  }
  if (p.required_review !== "single-agent") {
    // can two mapped agents differ in what required_review compares: the account, or the account's vendor?
    const on = [...new Set(Object.values(p.agents))];
    const kinds = p.required_review === "cross-vendor" ? [...new Set(on.map((a) => p.accounts[a]))] : on;
    const what = p.required_review === "cross-vendor" ? "vendor" : "account";
    rows.push(kinds.length >= 2 ? [true, "profile reviewers", `agents on ${what}s ${kinds.join(", ")}`]
      : [false, "profile reviewers", `required_review = ${p.required_review}, but ` +
        (kinds.length ? `every agent in [profile.agents] is on ${what} ${kinds[0]}` : "no agent is listed in [profile.agents]") +
        `; every PR stays BLOCKED until an agent on another ${what} is added`]);
  }
  const unmapped = env.configured.filter((n) => !Object.hasOwn(p.agents, n.normalize("NFC").toLowerCase()));
  rows.push(unmapped.length ? [false, "profile agents", `${unmapped.length} agent(s) in [agents.*] have no account in [profile.agents]; their approvals grade as single-agent`]
    : [true, "profile agents", `${Object.keys(p.agents).length} agent(s) mapped`]);
  return rows;
}

// ---- writing ----------------------------------------------------------------------------------

const TOP_ORDER = ["policy", "compute", "people", "lead_account", "required_review", "default_tier", "high_paths", "teammates", "max_workers"];

/** The [profile], [profile.accounts] and [profile.agents] tables for a raw profile object. */
export function renderProfile(raw: Record<string, any>): string {
  let s = "[profile]\n";
  for (const k of TOP_ORDER) if (raw[k] !== undefined) s += `${k} = ${tomlValue(raw[k])}\n`;
  for (const t of ["accounts", "agents"]) {
    s += `\n[profile.${t}]\n`;
    for (const [k, v] of Object.entries<string>(raw[t] ?? {})) s += `${tomlKey(k)} = ${tomlValue(v)}\n`;
  }
  return s;
}

const isProfileTable = (name: string[]) => name[0] === "profile";

/** Put `block` in place of the profile tables of a config text; every other byte stays. */
export function withProfileBlock(text: string, block: string): string {
  return replaceTables(text, isProfileTable, block);
}

/** Replace only the profile tables of a config text with a rendering of `raw`. */
export function writeProfileText(text: string, raw: Record<string, any>): string {
  return withProfileBlock(text, renderProfile(raw));
}

/** The profile tables of a config text, verbatim ("" when there are none). */
export function profileBlock(text: string): string {
  return tableRanges(text, isProfileTable).map(([s, e]) => text.slice(s, e)).join("");
}

/**
 * A new profile for `orch init`: the selection the person gave, written out in full, and starting
 * accounts from the agent CLIs detection found. The accounts are labels to edit, not a rule.
 * There is no default selection: the caller must have asked for one.
 */
export function initialProfile(compute: Compute, people: People, found: string[], sel: Selection): Record<string, any> {
  const accounts: Record<string, string> = {};
  if (found.length) {
    if (compute === "one") accounts.acct1 = found[0];
    else if (compute === "same-vendor") Object.assign(accounts, { acct1: found[0], acct2: found[0] });
    else found.forEach((v, i) => (accounts[`acct${i + 1}`] = v));
  }
  const raw: Record<string, any> = { policy: sel.policy, compute, people };
  if (Object.keys(accounts).length) raw.lead_account = "acct1";
  raw.required_review = sel.required_review;
  raw.max_workers = sel.max_workers;
  raw.accounts = accounts;
  raw.agents = {};
  return raw;
}
