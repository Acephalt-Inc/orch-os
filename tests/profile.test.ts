// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Profiles (docs/profiles.md): the human-merge example policy, the refusal of a profile written for the removed
// built-in table, grading, tiers, the gate, the table writer.
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import * as M from "../src/mergegate.js";
import * as P from "../src/profile.js";
import { parseToml, replaceTables, tableHeaders } from "../src/toml.js";

const prof = (toml: string) => P.readProfile(parseToml(toml))!;

/** The public example policy, written out: the three keys a profile must carry. */
const pol = (review: P.Strength = "single-agent", maxWorkers = 2) => `policy = "human-merge"\nrequired_review = "${review}"\nmax_workers = ${maxWorkers}\n`;
/** A [profile] head: the example policy plus the declared compute and people. */
const head = (compute: P.Compute, people: P.People, review: P.Strength = "single-agent", extra = "") =>
  `[profile]\n${pol(review)}compute = "${compute}"\npeople = "${people}"\n${extra}`;
const AUTO_REASON = "--auto: policy human-merge gives no automatic merge authority; a person performs the merge";

describe("ProfilePolicy", () => {
  it("the_example_policy_takes_every_value_from_the_table_as_written", () => {
    let n = 0;
    for (const compute of P.COMPUTES) for (const people of P.PEOPLE) for (const review of P.STRENGTHS) for (const tier of P.TIERS) {
      const needTeammate = people === "team" && tier === "high";
      expect(P.policyFor(prof(head(compute, people, review)), tier), `${compute} ${people} ${review} ${tier}`)
        .toEqual({ name: "human-merge", needAgent: review, needTeammate, authority: needTeammate ? "teammate" : "owner", workerCap: 2 });
      n++;
    }
    expect(n).toBe(36);
  });

  it("no_setup_gives_automatic_authority", () => {
    // every declared setup, review strength and tier: the authority is a person, and --auto is BLOCKED
    // even when the review, the teammate approval and every other rule are met
    const accounts = '[profile.accounts]\na1 = "claude"\na2 = "claude"\nx1 = "codex"\n[profile.agents]\nalice = "a1"\nbob = "x1"\n';
    for (const compute of P.COMPUTES) for (const people of P.PEOPLE) for (const review of P.STRENGTHS) for (const tier of P.TIERS) {
      const p = prof(head(compute, people, review, 'teammates = ["carol"]\n') + accounts);
      expect(["owner", "teammate"]).toContain(P.policyFor(p, tier).authority);
      const input = { tierFlag: tier, files: [], approvers: ["bob"], authors: ["alice"], githubApproved: ["bob", "carol"] };
      expect(P.gateProfile(p, input).ok, `${compute} ${people} ${review} ${tier}`).toBe(true); // control: the same input passes without --auto
      const auto = P.gateProfile(p, { ...input, auto: true });
      expect([auto.ok, auto.info.reasons], `${compute} ${people} ${review} ${tier}`).toEqual([false, [AUTO_REASON]]);
    }
  });

  it("the_worker_limit_is_the_written_value_never_derived", () => {
    // the number of accounts and the declared compute do not change it
    for (const compute of P.COMPUTES) {
      for (const accounts of ["", '[profile.accounts]\na1 = "claude"\n', '[profile.accounts]\na1 = "claude"\na2 = "claude"\na3 = "codex"\n']) {
        for (const n of [1, 3, 7]) {
          const p = prof(`[profile]\n${pol("single-agent", n)}compute = "${compute}"\npeople = "solo"\n${accounts}`);
          expect([p.max_workers, P.policyFor(p, "low").workerCap, P.policyFor(p, "high").workerCap]).toEqual([n, n, n]);
        }
      }
    }
  });

  it("an_unknown_tier_is_treated_as_high", () => {
    for (const people of P.PEOPLE) {
      const p = prof(head("one", people));
      const want = P.policyFor(p, "high");
      for (const t of ["medium", "HIGH", "LOW", "", undefined]) expect(P.policyFor(p, t as P.Tier), `${people} ${t}`).toEqual(want);
    }
    expect(P.policyFor(prof(head("one", "team")), "high").needTeammate).toBe(true); // and high is the tier that needs the teammate
    expect(P.policyFor(prof(head("one", "team")), "low").needTeammate).toBe(false);
  });
});

describe("ProfileLegacy", () => {
  it("a_profile_written_for_the_removed_table_is_refused_with_what_to_set", () => {
    // each of the six compute x people setups the removed table covered, with and without accounts
    for (const compute of P.COMPUTES) for (const people of P.PEOPLE) {
      for (const rest of ["", 'default_tier = "low"\nmax_workers = 3\n[profile.accounts]\na1 = "claude"\na2 = "codex"\n[profile.agents]\nw1 = "a1"\nr1 = "a2"\n']) {
        const toml = `[profile]\ncompute = "${compute}"\npeople = "${people}"\n${rest}`;
        expect(() => P.readProfile(parseToml(toml)), toml).toThrow(ConfigError);
        let msg = "";
        try {
          P.readProfile(parseToml(toml));
        } catch (e: any) {
          msg = e.message;
        }
        expect(msg).toContain("[profile] has no policy key");
        expect(msg).toContain("No rule is chosen for you and none is applied");
        for (const want of ['policy = "human-merge"', 'required_review = "single-agent" | "cross-account" | "cross-vendor"', "max_workers = N (N >= 1)",
          "orch profile update --policy human-merge --required-review cross-account --max-workers 2", "a person performs every merge", "docs/profiles.md"]) {
          expect(msg, want).toContain(want);
        }
        expect(msg).not.toContain("\n"); // one line, like every other config error
      }
    }
  });

  it("removed_worker_keys_and_unknown_policies_are_refused_not_reinterpreted", () => {
    const bad = [
      [head("same-vendor", "solo", "single-agent", "workers_per_account = 2\n"), "workers_per_account is not supported: the worker limit is not derived from the number of accounts"],
      ['[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\ncompute = "same-vendor"\npeople = "solo"\n', "max_workers is required"],
      ['[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 0\ncompute = "same-vendor"\npeople = "solo"\n', "max_workers must be an integer >= 1 (got 0)"],
      ['[profile]\npolicy = "human-merge"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n', "required_review is required"],
      ['[profile]\npolicy = "auto"\nrequired_review = "single-agent"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n', '[profile] policy must be "human-merge" (got "auto")'],
      ['[profile]\npolicy = "human-merge"\nrequired_review = "none"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n', "required_review must be"],
    ];
    for (const [toml, msg] of bad) {
      expect(() => P.readProfile(parseToml(toml)), toml).toThrow(ConfigError);
      expect(() => P.readProfile(parseToml(toml))).toThrow(msg);
    }
  });
});

const C_SOLO = `
[profile]
policy = "human-merge"
required_review = "cross-vendor"
max_workers = 2
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

describe("ProfileDeclaredContext", () => {
  const rowOf = (p: P.Profile, name: string) => P.capabilityRows(p, { found: [], configured: [], gh: false, repo: "" }).find((r) => r[1] === name);
  const gate = (p: P.Profile, extra: Partial<P.GateInput> = {}) =>
    P.gateProfile(p, { files: [], approvers: ["r1"], authors: ["w1"], githubApproved: [], ...extra });

  it("one_account_never_lowers_a_cross_account_requirement", () => {
    for (const people of P.PEOPLE) {
      const p = prof(head("same-vendor", people, "cross-account") + '[profile.accounts]\na1 = "claude"\n[profile.agents]\nw1 = "a1"\nr1 = "a1"\n');
      for (const tier of P.TIERS) expect(P.policyFor(p, tier).needAgent).toBe("cross-account");
      const g = gate(p, { tierFlag: "low" });
      expect([g.ok, g.info.needed, g.info.reasons]).toEqual([false, "cross-account", ["review strength single-agent is below cross-account"]]);
      expect(rowOf(p, "profile accounts")).toEqual([false, "profile accounts",
        "same-vendor declared, but only one account is listed in [profile.accounts]; no review can grade above single-agent until a second account is added"]);
      expect(rowOf(p, "profile reviewers")).toEqual([false, "profile reviewers",
        "required_review = cross-account, but every agent in [profile.agents] is on account a1; every PR stays BLOCKED until an agent on another account is added"]);
    }
  });

  it("vendor_names_are_trimmed_and_lower_cased", () => {
    const p = prof(C_SOLO.replace('c2 = "claude"', 'c2 = "Claude "').replace('x1 = "codex"', 'x1 = "CODEX"'));
    expect(p.accounts).toEqual({ c1: "claude", c2: "claude", x1: "codex" });
    expect(P.grade(p, "lead", ["w1"])).toBe("cross-account");
    expect(rowOf(p, "profile vendors")).toEqual([true, "profile vendors", "claude, codex"]);
    const same = prof(C_SOLO.replace('x1 = "codex"', 'x1 = "Claude"'));
    expect(P.grade(same, "rx", ["w1"])).toBe("cross-account");
    expect(rowOf(same, "profile vendors")![0]).toBe(false);
  });

  it("one_vendor_never_lowers_a_cross_vendor_requirement", () => {
    const p = prof(C_SOLO.replace('x1 = "codex"', 'x1 = "claude"'));
    for (const tier of P.TIERS) expect([P.policyFor(p, tier).needAgent, P.policyFor(p, tier).authority]).toEqual(["cross-vendor", "owner"]);
    // rx is on another account of the same vendor: cross-account, which stays below what the profile asks for
    const g = gate(p, { approvers: ["rx"], tierFlag: "high" });
    expect([g.ok, g.info.achieved, g.info.reasons]).toEqual([false, "cross-account", ["review strength cross-account is below cross-vendor"]]);
    expect(rowOf(p, "profile vendors")).toEqual([false, "profile vendors",
      "multi-vendor declared, but every account is on 'claude'; no review can grade as cross-vendor until an account on another vendor is added"]);
    expect(rowOf(p, "profile reviewers")).toEqual([false, "profile reviewers",
      "required_review = cross-vendor, but every agent in [profile.agents] is on vendor claude; every PR stays BLOCKED until an agent on another vendor is added"]);
  });

  it("agents_on_one_account_keep_the_teammate_rule_and_the_requirement", () => {
    const p = prof(head("same-vendor", "team", "cross-account", 'teammates = ["carol"]\n') + '[profile.accounts]\na1 = "codex"\na2 = "codex"\n[profile.agents]\nw1 = "a1"\nr1 = "a1"\n');
    const high = P.policyFor(p, "high");
    expect([high.needAgent, high.authority, high.needTeammate]).toEqual(["cross-account", "teammate", true]);
    expect(gate(p, { tierFlag: "high", githubApproved: ["carol"] }).info.reasons).toEqual(["review strength single-agent is below cross-account"]);
    expect(rowOf(p, "profile reviewers")![0]).toBe(false);
  });

  it("a_fully_backed_profile_has_no_missing_capability_and_still_no_auto", () => {
    const p = prof(C_SOLO);
    const rows = P.capabilityRows(p, { found: ["claude", "codex"], configured: [], gh: true, repo: "o/n" });
    expect(rows.map((r) => [r[0], r[1]])).toEqual([[true, "profile"], [true, "profile accounts"], [true, "profile vendors"],
      [true, "profile vendor claude"], [true, "profile vendor codex"], [true, "profile reviewers"], [true, "profile agents"]]);
    expect(rows[0][2]).toBe("human-merge (multi-vendor · solo): accounts c1, c2 (claude), x1 (codex)");
    expect(gate(p, { approvers: ["rx"] }).ok).toBe(true);
    expect(gate(p, { approvers: ["rx"], auto: true }).info.reasons).toEqual([AUTO_REASON]);
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
  const withPaths = (extra = "") => prof(head("one", "solo", "single-agent", `high_paths = ["migrations/**", "src/*.ts"]\n${extra}`));

  it("flag_then_path_then_default", () => {
    expect(P.chooseTier(withPaths(), "low", ["migrations/1.sql"])).toEqual({ tier: "low", source: "flag" }); // --tier low beats a path
    expect(P.chooseTier(withPaths(), "high", null)).toEqual({ tier: "high", source: "flag" });
    expect(P.chooseTier(withPaths(), null, ["README.md", "migrations/0042.sql"])).toEqual({ tier: "high", source: "path: migrations/0042.sql" });
    expect(P.chooseTier(withPaths('default_tier = "low"'), null, ["README.md"])).toEqual({ tier: "low", source: "default" });
    expect(P.chooseTier(withPaths(), null, ["README.md"])).toEqual({ tier: "high", source: "default" }); // default_tier defaults to high
    expect(P.chooseTier(withPaths('default_tier = "low"'), null, null)).toEqual({ tier: "high", source: "files unreadable" });
    expect(P.chooseTier(prof(head("one", "solo", "single-agent", 'default_tier = "low"\n')), null, null)).toEqual({ tier: "low", source: "default" });
  });

  it("a_leading_slash_in_high_paths_is_dropped", () => {
    const p = prof(head("one", "solo", "single-agent", 'default_tier = "low"\nhigh_paths = ["/migrations/**", "//infra/*.tf"]\n'));
    expect(p.high_paths).toEqual(["migrations/**", "infra/*.tf"]);
    expect(P.chooseTier(p, null, ["migrations/0042.sql"])).toEqual({ tier: "high", source: "path: migrations/0042.sql" });
    expect(P.chooseTier(p, null, ["infra/dns.tf"]).tier).toBe("high");
    expect(() => prof(head("one", "solo", "single-agent", 'high_paths = ["/"]\n'))).toThrow("high_paths: '/' matches no file");
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
    expect(M.changedFiles({ files: [{ path: 3 }], changedFiles: 1 })).toBeNull();
    expect(M.changedFiles({ files: [{ path: "a" }] })).toBeNull(); // no count: cannot tell it is complete
    expect(M.changedFiles({ files: [{ path: "a" }], changedFiles: 2 })).toBeNull(); // a partial list
    expect(M.changedFiles({ files: [{ path: "a" }], changedFiles: 1 })).toEqual(["a"]);
  });
});

const TEAM_E = `
[profile]
policy = "human-merge"
required_review = "cross-account"
max_workers = 2
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

  it("auto_never_passes_and_a_person_performs_the_merge", () => {
    // low tier, review rule met: PASS for a person, BLOCKED for --auto
    expect([gate(e, { tierFlag: "low" }).ok, gate(e, { tierFlag: "low" }).info.authority]).toEqual([true, "owner"]);
    const lo = gate(e, { tierFlag: "low", auto: true });
    expect([lo.ok, lo.info.reasons]).toEqual([false, [AUTO_REASON]]);
    // high tier with the teammate's approval: the same
    expect([gate(e, { tierFlag: "high", githubApproved: ["bob", "carol"] }).ok, gate(e, { tierFlag: "high", githubApproved: ["bob", "carol"] }).info.authority]).toEqual([true, "teammate"]);
    const hi = gate(e, { tierFlag: "high", auto: true, githubApproved: ["bob", "carol"] });
    expect([hi.ok, hi.info.reasons]).toEqual([false, [AUTO_REASON]]);
    const b = prof(TEAM_E.replace('people = "team"', 'people = "solo"'));
    for (const tier of P.TIERS) {
      const own = gate(b, { tierFlag: tier, auto: true });
      expect([own.ok, own.info.reasons]).toEqual([false, [AUTO_REASON]]);
      expect(gate(b, { tierFlag: tier }).ok).toBe(true); // without --auto the owner rule passes
    }
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

  it("strength_and_verdict_lines_match_the_documented_examples", () => {
    const c = prof(C_SOLO.replace("[profile.agents]", '[profile.agents]\nalice = "c2"\nbob = "c1"').replace('people = "solo"', 'people = "solo"\nhigh_paths = ["infra/**"]'));
    const g1 = P.gateProfile(c, { files: ["infra/dns.tf"], approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect([P.strengthLine(g1.info), P.verdictLine(g1.ok, g1.info)]).toEqual([
      "profile=human-merge tier=high(path: infra/dns.tf) review=cross-account needed=cross-vendor teammate=n/a authority=owner",
      "=> BLOCKED (review strength cross-account is below cross-vendor)"]);
    const b = prof(TEAM_E.replace('people = "team"', 'people = "solo"'));
    const g2 = P.gateProfile(b, { tierFlag: "low", files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect([P.strengthLine(g2.info), P.verdictLine(g2.ok, g2.info)]).toEqual([
      "profile=human-merge tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=owner", "=> PASS (the owner decides the merge)"]);
    const a = prof(head("one", "solo") + '[profile.accounts]\nmain = "claude"\n[profile.agents]\nw1 = "main"\nr1 = "main"\n');
    const g3 = P.gateProfile(a, { files: null, approvers: ["r1"], authors: ["w1"], githubApproved: [] });
    expect([P.strengthLine(g3.info), P.verdictLine(g3.ok, g3.info)]).toEqual([
      "profile=human-merge tier=high(default) review=single-agent needed=single-agent teammate=n/a authority=owner",
      "=> PASS (single-agent review only; the owner decides the merge)"]);
    const g4 = P.gateProfile(e, { tierFlag: "high", files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob", "carol"] });
    expect([P.strengthLine(g4.info), P.verdictLine(g4.ok, g4.info)]).toEqual([
      "profile=human-merge tier=high(flag) review=cross-account needed=cross-account teammate=approved authority=teammate",
      "=> PASS (the teammate who approved, or the owner, performs the merge)"]);
    expect(Object.keys(g4.info)).toEqual(["policy", "tier", "tier_source", "achieved", "needed", "teammate", "need_teammate", "authority", "worker_cap", "reasons"]);
  });

  it("a_requirement_the_setup_cannot_meet_blocks_and_names_the_shortfall", () => {
    // same-vendor declared with one account and unmapped agents: the removed table lowered this to a single-agent rule; now it blocks
    const p = prof(head("same-vendor", "solo", "cross-account") + '[profile.accounts]\na1 = "claude"\n');
    const g = P.gateProfile(p, { tierFlag: "low", files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect(P.strengthLine(g.info)).toBe("profile=human-merge tier=low(flag) review=single-agent (unmapped) needed=cross-account teammate=n/a authority=owner");
    expect(P.verdictLine(g.ok, g.info)).toBe("=> BLOCKED (review strength single-agent (unmapped) is below cross-account)");
    const auto = P.gateProfile(p, { tierFlag: "low", auto: true, files: null, approvers: ["bob"], authors: ["alice"], githubApproved: ["bob"] });
    expect(P.verdictLine(auto.ok, auto.info)).toBe(`=> BLOCKED (review strength single-agent (unmapped) is below cross-account; ${AUTO_REASON})`);
  });
});

describe("ProfileConfig", () => {
  it("validation_errors_are_config_errors", () => {
    const bad = [
      [`[profile]\n${pol()}people = "solo"\n`, "compute is required"],
      [`[profile]\n${pol()}compute = "two"\npeople = "solo"\n`, 'compute must be "one" or "same-vendor" or "multi-vendor"'],
      [head("one", "crowd" as P.People), "people must be"],
      [head("one", "solo", "single-agent", 'default_tier = "medium"\n'), "default_tier must be"],
      [`[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = -1\ncompute = "one"\npeople = "solo"\n`, "max_workers must be an integer >= 1"],
      [`[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 1.5\ncompute = "one"\npeople = "solo"\n`, "max_workers must be an integer >= 1"],
      [head("one", "solo", "single-agent", "high_path = []\n"), "unknown key 'high_path'"],
      [head("one", "solo", "single-agent", 'teammates = "carol"\n'), "teammates must be an array"],
      [head("one", "solo") + '[profile.agents]\nr1 = "nope"\n', "'nope' is not an account"],
      [head("one", "solo", "single-agent", 'lead_account = "x"\n'), "lead_account must be an account"],
      [head("one", "solo") + "[profile.accounts]\na1 = 3\n", "a1 must be a vendor name"],
    ];
    for (const [toml, msg] of bad) {
      expect(() => P.readProfile(parseToml(toml)), toml).toThrow(ConfigError);
      expect(() => P.readProfile(parseToml(toml))).toThrow(msg);
    }
    expect(P.readProfile(parseToml('[orch]\nteam = "x"\n'))).toBeNull();
    // declared compute the accounts do not back is not a config error (a missing capability instead)
    expect(prof(head("multi-vendor", "team")).compute).toBe("multi-vendor");
    expect(prof(head("one", "solo") + '[profile.accounts]\nonly = "claude"\n').lead_account).toBe("only");
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

  it("writer_keeps_crlf", () => {
    const crlf = TEXT.replace(/\n/g, "\r\n");
    const raw = { compute: "one", people: "solo", accounts: { a1: "claude" }, agents: {} };
    const out = P.writeProfileText(crlf, raw);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(out.startsWith(crlf.slice(0, crlf.indexOf("[profile]")))).toBe(true);
    expect(out.endsWith(crlf.slice(crlf.indexOf("\r\n# about workers")))).toBe(true);
    expect(parseToml(out).profile).toEqual(raw);
    const noProfile = '[orch]\r\nteam = "x"\r\n';
    expect(P.writeProfileText(noProfile, raw)).toBe(noProfile + "\r\n" + P.renderProfile(raw).replace(/\n/g, "\r\n"));
  });

  it("profile_block_is_verbatim", () => {
    expect(P.profileBlock(TEXT)).toBe('[profile]\ncompute = "one"\npeople = "solo"\n\n[profile.accounts]\nmain = "claude"\n');
    expect(P.profileBlock('[orch]\nteam = "x"\n')).toBe("");
    expect(tableHeaders(TEXT).map((h) => h.name.join("."))).toEqual(["orch", "merge", "profile", "profile.accounts", "workers"]);
    // a header-looking line inside a multi-line array is not a header
    const arr = '[profile]\ncompute = "one"\npeople = "solo"\nhigh_paths = [\n  "a",\n]\n[w]\nx = [\n [1],\n]\n';
    expect(replaceTables(arr, (n) => n[0] === "profile", "")).toBe('[w]\nx = [\n [1],\n]\n');
  });

  it("initial_profile_writes_the_example_policy_and_the_detected_clis", () => {
    const example = { policy: "human-merge", required_review: "single-agent", max_workers: 1 };
    expect(P.initialProfile("one", "solo", ["codex", "claude"])).toEqual({ ...example, compute: "one", people: "solo", lead_account: "acct1", accounts: { acct1: "codex" }, agents: {} });
    expect(P.initialProfile("same-vendor", "team", ["claude"]).accounts).toEqual({ acct1: "claude", acct2: "claude" });
    expect(P.initialProfile("multi-vendor", "solo", ["claude", "codex"]).accounts).toEqual({ acct1: "claude", acct2: "codex" });
    expect(P.initialProfile("multi-vendor", "solo", [])).toEqual({ ...example, compute: "multi-vendor", people: "solo", accounts: {}, agents: {} });
    // the same example for every setup: the number of accounts or vendors found changes no policy value
    for (const compute of P.COMPUTES) for (const people of P.PEOPLE) {
      const raw = P.initialProfile(compute, people, ["claude", "codex"]);
      expect([raw.policy, raw.required_review, raw.max_workers]).toEqual(["human-merge", "single-agent", 1]);
      expect(P.readProfile(parseToml(P.renderProfile(raw)))!.max_workers).toBe(1); // what init writes reads back
    }
  });
});
