// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Adaptive profiles (docs/profiles.md): policy(), degrade rules, grading, tiers, the gate, the table writer.
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import * as M from "../src/mergegate.js";
import * as P from "../src/profile.js";
import { parseToml, replaceTables, tableHeaders } from "../src/toml.js";

const prof = (toml: string) => P.readProfile(parseToml(toml))!;

/** docs/profiles.md section 5, "Decision table", copied as written. */
const DOC_TABLE = `
| A one · solo | low | single-agent | no | owner |
| A one · solo | high | single-agent | no | owner |
| B same-vendor · solo | low | cross-account | no | auto |
| B same-vendor · solo | high | cross-account | no | owner |
| C multi-vendor · solo | low | cross-account | no | auto |
| C multi-vendor · solo | high | cross-vendor | no | owner |
| D one · team | low | single-agent | yes | teammate |
| D one · team | high | single-agent | yes | teammate |
| E same-vendor · team | low | cross-account | no | auto |
| E same-vendor · team | high | cross-account | yes | teammate |
| F multi-vendor · team | low | cross-vendor | no | auto |
| F multi-vendor · team | high | cross-vendor | yes | teammate |
`;

const ROWS = DOC_TABLE.trim().split("\n").map((line) => {
  const [cellCol, tier, needAgent, needTeammate, authority] = line.split("|").slice(1, -1).map((x) => x.trim());
  const [cell, compute, , people] = cellCol.split(" ");
  return { cell, compute: compute as P.Compute, people: people as P.People, tier: tier as P.Tier, needAgent, needTeammate: needTeammate === "yes", authority };
});

const input = (compute: P.Compute, people: P.People, extra: Partial<P.PolicyInput> = {}): P.PolicyInput =>
  ({ compute, people, accounts: 3, workersPerAccount: 2, maxWorkers: 0, ...extra });

describe("ProfilePolicy", () => {
  it("all_12_rows_of_the_decision_table", () => {
    expect(ROWS.length).toBe(12);
    for (const row of ROWS) {
      const got = P.policy(input(row.compute, row.people), row.tier);
      expect({ cell: got.cell, needAgent: got.needAgent, needTeammate: got.needTeammate, authority: got.authority }, `${row.cell} ${row.tier}`)
        .toEqual({ cell: row.cell, needAgent: row.needAgent, needTeammate: row.needTeammate, authority: row.authority });
    }
  });

  it("worker_cap_per_cell_and_override", () => {
    for (const people of P.PEOPLE) {
      expect(P.policy(input("one", people), "low").workerCap).toBe(1); // A, D: lead and one worker take turns
      for (const compute of ["same-vendor", "multi-vendor"] as P.Compute[]) {
        expect(P.policy(input(compute, people), "high").workerCap).toBe(4); // 2 per account x (3 accounts - lead's)
        expect(P.policy(input(compute, people, { accounts: 2 }), "high").workerCap).toBe(2);
        expect(P.policy(input(compute, people, { workersPerAccount: 0 }), "high").workerCap).toBe(1); // at least 1
      }
      for (const compute of P.COMPUTES) expect(P.policy(input(compute, people, { maxWorkers: 7 }), "low").workerCap).toBe(7);
    }
  });

  it("a_degrade_never_gives_auto", () => {
    for (const row of ROWS) {
      const got = P.policy(input(row.compute, row.people, { degraded: true }), row.tier);
      expect(got.authority, `${row.cell} ${row.tier}`).not.toBe("auto");
      if (row.authority === "auto") expect(got.authority).toBe(row.people === "solo" ? "owner" : "teammate");
      if (got.authority === "teammate") expect(got.needTeammate).toBe(true);
      expect(got.needAgent).toBe(row.needAgent);
    }
  });
});

const C_SOLO = `
[profile]
compute = "multi-vendor"
people = "solo"

[profile.accounts]
c1 = "claude"
c2 = "claude"
x1 = "codex"

[profile.agents]
lead = "c1"
w1 = "c2"
w2 = "c2"
rx = "x1"
x2 = "x1"
`;

describe("ProfileDegrade", () => {
  it("one_account_drops_to_the_one_column", () => {
    for (const people of P.PEOPLE) {
      const p = prof(`[profile]\ncompute = "same-vendor"\npeople = "${people}"\n[profile.accounts]\na1 = "claude"\n[profile.agents]\nw1 = "a1"\n`);
      expect(P.effective(p)).toEqual({ compute: "one", degraded: ["one-account"] });
      const pol = P.policyFor(p, "low");
      expect([pol.cell, pol.declaredCell, pol.authority]).toEqual([people === "solo" ? "A" : "D", people === "solo" ? "B" : "E", people === "solo" ? "owner" : "teammate"]);
    }
  });

  it("one_vendor_drops_multi_vendor_to_same_vendor_without_auto", () => {
    const p = prof(C_SOLO.replace('x1 = "codex"', 'x1 = "claude"'));
    expect(P.effective(p)).toEqual({ compute: "same-vendor", degraded: ["no-second-vendor"] });
    expect([P.policyFor(p, "high").cell, P.policyFor(p, "high").needAgent, P.policyFor(p, "high").authority]).toEqual(["B", "cross-account", "owner"]);
    expect(P.policyFor(p, "low").authority).toBe("owner");
  });

  it("agents_on_one_account_withdraw_auto", () => {
    const p = prof(`[profile]\ncompute = "same-vendor"\npeople = "team"\nteammates = ["carol"]\n[profile.accounts]\na1 = "codex"\na2 = "codex"\n[profile.agents]\nw1 = "a1"\nr1 = "a1"\n`);
    expect(P.effective(p)).toEqual({ compute: "same-vendor", degraded: ["one-reviewer-account"] });
    const low = P.policyFor(p, "low");
    expect([low.cell, low.authority, low.needTeammate]).toEqual(["E", "teammate", true]);
  });

  it("a_fully_backed_profile_has_no_degrade", () => {
    const p = prof(C_SOLO);
    expect(P.effective(p)).toEqual({ compute: "multi-vendor", degraded: [] });
    expect(P.policyFor(p, "low").authority).toBe("auto");
  });
});

describe("ProfileGrading", () => {
  const p = prof(C_SOLO);

  it("same_account_cross_account_cross_vendor", () => {
    expect(P.grade(p, "w2", ["w1"])).toBe("single-agent");
    expect(P.grade(p, "lead", ["w1"])).toBe("cross-account");
    expect(P.grade(p, "rx", ["w1"])).toBe("cross-vendor");
    expect(P.grade(p, "RX", ["W1"])).toBe("cross-vendor"); // names compare case-insensitively
  });

  it("unknown_reviewer_or_author_is_weakest", () => {
    expect(P.grade(p, "zz", ["w1"])).toBe("single-agent (unmapped)");
    expect(P.grade(p, "rx", ["zz"])).toBe("single-agent (unmapped)");
    expect(P.grade(p, "rx", [])).toBe("single-agent (unmapped)");
    // names that are Object.prototype members are not mapped agents
    for (const n of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(P.grade(p, n, ["w1"]), n).toBe("single-agent (unmapped)");
      expect(P.grade(p, "rx", [n]), n).toBe("single-agent (unmapped)");
    }
  });

  it("several_authors_the_weakest_holds", () => {
    // after a hand-off, x2 (same account as rx) is also an author: rx is not independent of it
    expect(P.grade(p, "rx", ["w1", "x2"])).toBe("single-agent");
    expect(P.grade(p, "rx", ["w1", "lead"])).toBe("cross-vendor");
  });

  it("several_approvals_the_strongest_holds", () => {
    expect(P.achieved(p, ["w2", "lead", "rx"], ["w1"])).toBe("cross-vendor");
    expect(P.achieved(p, ["w2", "zz"], ["w1"])).toBe("single-agent");
    expect(P.achieved(p, ["zz"], ["w1"])).toBe("single-agent (unmapped)");
    expect(P.achieved(p, [], ["w1"])).toBe("none");
    expect(P.meets("none", "single-agent")).toBe(false);
    expect(P.meets("single-agent (unmapped)", "single-agent")).toBe(true);
    expect(P.meets("single-agent (unmapped)", "cross-account")).toBe(false);
    expect(P.meets("cross-vendor", "cross-account")).toBe(true);
  });
});

describe("ProfileTier", () => {
  const withPaths = (extra = "") => prof(`[profile]\ncompute = "one"\npeople = "solo"\nhigh_paths = ["migrations/**", "src/*.ts"]\n${extra}`);

  it("flag_then_path_then_default", () => {
    expect(P.chooseTier(withPaths(), "low", ["migrations/1.sql"])).toEqual({ tier: "low", source: "flag" }); // --tier low beats a path
    expect(P.chooseTier(withPaths(), "high", null)).toEqual({ tier: "high", source: "flag" });
    expect(P.chooseTier(withPaths(), null, ["README.md", "migrations/0042.sql"])).toEqual({ tier: "high", source: "path: migrations/0042.sql" });
    expect(P.chooseTier(withPaths('default_tier = "low"'), null, ["README.md"])).toEqual({ tier: "low", source: "default" });
    expect(P.chooseTier(withPaths(), null, ["README.md"])).toEqual({ tier: "high", source: "default" }); // default_tier defaults to high
    expect(P.chooseTier(withPaths('default_tier = "low"'), null, null)).toEqual({ tier: "high", source: "files unreadable" });
    expect(P.chooseTier(prof('[profile]\ncompute = "one"\npeople = "solo"\ndefault_tier = "low"\n'), null, null)).toEqual({ tier: "low", source: "default" });
  });

  it("globs", () => {
    const m = (g: string, f: string) => P.globRe(g).test(f);
    expect([m("src/*.ts", "src/a.ts"), m("src/*.ts", "src/x/a.ts"), m("src/**", "src/x/a.ts"), m("src/**", "src/a.ts")]).toEqual([true, false, true, true]);
    expect([m("**/*.sql", "a.sql"), m("**/*.sql", "x/y/a.sql"), m("a?.ts", "ab.ts"), m("a?.ts", "a/.ts")]).toEqual([true, true, true, false]);
    expect([m("a.ts", "abts"), m("infra/**", "infra"), m("migrations/**", "migrations/0042.sql")]).toEqual([false, false, true]);
  });

  it("changed_files_are_read_or_null", () => {
    expect(M.changedFiles(M.loadFixture("high-path"))).toEqual(["src/app.ts", "migrations/0042_add_index.sql"]);
    expect(M.changedFiles(M.loadFixture("approved"))).toBeNull();
    expect(M.changedFiles({ files: [{ path: 3 }] })).toBeNull();
  });
});

const TEAM_E = `
[profile]
compute = "same-vendor"
people = "team"
teammates = ["Carol"]

[profile.accounts]
a1 = "claude"
a2 = "claude"

[profile.agents]
bob = "a1"
alice = "a2"
`;

describe("ProfileGate", () => {
  const e = prof(TEAM_E);
  const gate = (p: P.Profile, extra: Partial<P.GateInput> = {}) =>
    P.gateProfile(p, { files: [], approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"], ...extra });

  it("auto_passes_only_under_auto_authority", () => {
    expect(gate(e, { tierFlag: "low", auto: true }).ok).toBe(true);
    const hi = gate(e, { tierFlag: "high", auto: true, githubApproved: ["bob", "carol"] });
    expect([hi.ok, hi.info.reasons]).toEqual([false, ["--auto: merge authority is teammate, not auto"]]);
    const b = prof(TEAM_E.replace('people = "team"', 'people = "solo"'));
    const own = gate(b, { tierFlag: "high", auto: true });
    expect([own.ok, own.info.reasons]).toEqual([false, ["--auto: merge authority is owner, not auto"]]);
    expect(gate(b, { tierFlag: "high" }).ok).toBe(true); // without --auto the owner rule passes
  });

  it("teammate_approval_at_head_listed_not_author", () => {
    expect(gate(e, { tierFlag: "high", githubApproved: ["bob", "carol"] }).info.teammate).toBe("approved"); // listed as "Carol": case-insensitive
    const miss = gate(e, { tierFlag: "high", githubApproved: ["bob", "dave"] });
    expect([miss.ok, miss.info.teammate, miss.info.reasons]).toEqual([false, "missing", ["a teammate's approval at the head is required"]]);
    expect(M.githubApprovedAtHead(M.loadFixture("teammate-approved"))).toEqual(["bob", "carol"]);
    expect(M.githubApprovedAtHead(M.loadFixture("teammate-stale"))).toEqual(["bob"]); // a stale approval does not count
    const own = structuredClone(M.loadFixture("teammate-approved") as Record<string, any>);
    own.author = { login: "carol" }; // the teammate is the PR author: never counts
    expect(M.githubApprovedAtHead(own)).toEqual(["bob"]);
    expect(gate(prof(TEAM_E.replace('people = "team"', 'people = "solo"')), { githubApproved: ["carol"] }).info.teammate).toBe("n/a");
  });

  it("team_without_teammates_blocks_where_a_teammate_is_needed", () => {
    const p = prof(TEAM_E.replace('teammates = ["Carol"]', ""));
    const g = gate(p, { tierFlag: "high" });
    expect([g.ok, g.info.reasons]).toEqual([false, ["no teammates listed in [profile] teammates"]]);
    expect(gate(p, { tierFlag: "low" }).ok).toBe(true);
  });

  it("strength_and_verdict_lines_match_the_design_examples", () => {
    const c = prof(C_SOLO.replace("[profile.agents]", '[profile.agents]\nalice = "c2"\nbob = "c1"').replace('people = "solo"', 'people = "solo"\nhigh_paths = ["infra/**"]'));
    const g1 = P.gateProfile(c, { files: ["infra/dns.tf"], approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect([P.strengthLine(g1.info), P.verdictLine(g1.ok, g1.info)]).toEqual([
      "profile=C tier=high(path: infra/dns.tf) review=cross-account needed=cross-vendor teammate=n/a authority=owner",
      "=> BLOCKED (review strength cross-account is below cross-vendor)"]);
    const b = prof(TEAM_E.replace('people = "team"', 'people = "solo"'));
    const g2 = P.gateProfile(b, { tierFlag: "low", files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect([P.strengthLine(g2.info), P.verdictLine(g2.ok, g2.info)]).toEqual([
      "profile=B tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=auto", "=> PASS"]);
    const a = prof('[profile]\ncompute = "one"\npeople = "solo"\n[profile.accounts]\nmain = "claude"\n[profile.agents]\nw1 = "main"\nr1 = "main"\n');
    const g3 = P.gateProfile(a, { files: null, approvers: ["r1"], authors: ["w1"], githubApproved: [] });
    expect([P.strengthLine(g3.info), P.verdictLine(g3.ok, g3.info)]).toEqual([
      "profile=A tier=high(default) review=single-agent needed=single-agent teammate=n/a authority=owner",
      "=> PASS (single-agent review only; the owner decides the merge)"]);
  });

  it("a_degraded_verdict_names_the_missing_capability", () => {
    const p = prof('[profile]\ncompute = "same-vendor"\npeople = "solo"\n[profile.accounts]\na1 = "claude"\n');
    const g = P.gateProfile(p, { tierFlag: "low", auto: true, files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect(P.strengthLine(g.info)).toBe("profile=A tier=low(flag) review=single-agent (unmapped) needed=single-agent teammate=n/a authority=owner degraded=one-account");
    expect(P.verdictLine(g.ok, g.info)).toBe("=> BLOCKED (--auto: merge authority is owner, not auto; missing: fewer than two accounts in [profile.accounts])");
  });
});

describe("ProfileConfig", () => {
  it("validation_errors_are_config_errors", () => {
    const bad = [
      ['[profile]\npeople = "solo"\n', "compute is required"],
      ['[profile]\ncompute = "two"\npeople = "solo"\n', 'compute must be "one" or "same-vendor" or "multi-vendor"'],
      ['[profile]\ncompute = "one"\npeople = "crowd"\n', "people must be"],
      ['[profile]\ncompute = "one"\npeople = "solo"\ndefault_tier = "medium"\n', "default_tier must be"],
      ['[profile]\ncompute = "one"\npeople = "solo"\nmax_workers = -1\n', "max_workers must be an integer >= 0"],
      ['[profile]\ncompute = "one"\npeople = "solo"\nworkers_per_account = 1.5\n', "workers_per_account must be an integer >= 0"],
      ['[profile]\ncompute = "one"\npeople = "solo"\nhigh_path = []\n', "unknown key 'high_path'"],
      ['[profile]\ncompute = "one"\npeople = "solo"\nteammates = "carol"\n', "teammates must be an array"],
      ['[profile]\ncompute = "one"\npeople = "solo"\n[profile.agents]\nr1 = "nope"\n', "'nope' is not an account"],
      ['[profile]\ncompute = "one"\npeople = "solo"\nlead_account = "x"\n', "lead_account must be an account"],
      ['[profile]\ncompute = "one"\npeople = "solo"\n[profile.accounts]\na1 = 3\n', "a1 must be a vendor name"],
    ];
    for (const [toml, msg] of bad) {
      expect(() => P.readProfile(parseToml(toml)), toml).toThrow(ConfigError);
      expect(() => P.readProfile(parseToml(toml))).toThrow(msg);
    }
    expect(P.readProfile(parseToml('[orch]\nteam = "x"\n'))).toBeNull();
    // declared compute the accounts do not back is not a config error (a degrade instead)
    expect(P.readProfile(parseToml('[profile]\ncompute = "multi-vendor"\npeople = "team"\n'))!.compute).toBe("multi-vendor");
    expect(prof('[profile]\ncompute = "one"\npeople = "solo"\n[profile.accounts]\nonly = "claude"\n').lead_account).toBe("only");
  });

  const TEXT = `# top comment
[orch]
team = "x"  # trailing comment

# about merge
[merge]
repo = ""

[profile]
compute = "one"
people = "solo"

[profile.accounts]
main = "claude"

# about workers: belongs to [workers]
[workers]
nice = 5
`;

  it("writer_replaces_only_the_profile_tables", () => {
    const raw = { compute: "same-vendor", people: "team", teammates: ["carol"], accounts: { a1: "codex", "a.2": "codex" }, agents: { w1: "a1", r1: "a.2" } };
    const out = P.writeProfileText(TEXT, raw);
    const pre = TEXT.slice(0, TEXT.indexOf("[profile]"));
    const post = TEXT.slice(TEXT.indexOf("\n# about workers"));
    expect(out.startsWith(pre)).toBe(true);
    expect(out.endsWith(post)).toBe(true);
    expect(out.slice(pre.length, out.length - post.length)).toBe(P.renderProfile(raw));
    expect(parseToml(out).profile).toEqual(raw);
    expect(parseToml(out).workers).toEqual({ nice: 5 });
    expect(out).toContain('"a.2" = "codex"'); // a key that is not bare is quoted
    expect(P.writeProfileText(out, raw)).toBe(out); // idempotent
  });

  it("writer_round_trip_append_and_split_tables", () => {
    const noProfile = '# c\n[orch]\nteam = "x"\n';
    const raw = { compute: "one", people: "solo", accounts: {}, agents: {} };
    expect(P.writeProfileText(noProfile, raw)).toBe(noProfile + "\n" + P.renderProfile(raw));
    expect(P.writeProfileText(noProfile.slice(0, -1), raw)).toBe(noProfile.slice(0, -1) + "\n\n" + P.renderProfile(raw));
    // tables split around another table: both go, the block takes the first one's place, [merge] stays
    const split = '[profile]\ncompute = "one"\npeople = "solo"\n\n[merge]\nrepo = "o/n"\n\n[profile.agents]\nr1 = "a"\n';
    const out = P.writeProfileText(split, raw);
    expect(out).toBe(P.renderProfile(raw) + '\n[merge]\nrepo = "o/n"\n\n');
    expect(parseToml(out).merge).toEqual({ repo: "o/n" });
  });

  it("profile_block_is_verbatim", () => {
    expect(P.profileBlock(TEXT)).toBe('[profile]\ncompute = "one"\npeople = "solo"\n\n[profile.accounts]\nmain = "claude"\n');
    expect(P.profileBlock('[orch]\nteam = "x"\n')).toBe("");
    expect(tableHeaders(TEXT).map((h) => h.name.join("."))).toEqual(["orch", "merge", "profile", "profile.accounts", "workers"]);
    // a header-looking line inside a multi-line array is not a header
    const arr = '[profile]\ncompute = "one"\npeople = "solo"\nhigh_paths = [\n  "a",\n]\n[w]\nx = [\n [1],\n]\n';
    expect(replaceTables(arr, (n) => n[0] === "profile", "")).toBe('[w]\nx = [\n [1],\n]\n');
  });

  it("initial_profile_uses_the_detected_clis", () => {
    expect(P.initialProfile("one", "solo", ["codex", "claude"])).toEqual({ compute: "one", people: "solo", lead_account: "acct1", accounts: { acct1: "codex" }, agents: {} });
    expect(P.initialProfile("same-vendor", "team", ["claude"]).accounts).toEqual({ acct1: "claude", acct2: "claude" });
    expect(P.initialProfile("multi-vendor", "solo", ["claude", "codex"]).accounts).toEqual({ acct1: "claude", acct2: "codex" });
    expect(P.initialProfile("multi-vendor", "solo", [])).toEqual({ compute: "multi-vendor", people: "solo", accounts: {}, agents: {} });
  });
});
