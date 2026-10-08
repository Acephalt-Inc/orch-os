// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch review watch`: CI at the head, reviewer choice per profile cell, one dispatch per head.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as P from "../src/profile.js";
import * as RW from "../src/reviewwatch.js";
import { parseToml } from "../src/toml.js";
import { AttendedWorkers as Workers, useAttendedTerminal } from "./_attended.js";
import { run, tmp, useTmpHome, waitFor } from "./_helpers.js";

const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const green = (sha: string, name = "build"): RW.CheckRow => ({ sha, name, state: "SUCCESS" });
const row = (sha: string, state: string, name = "build"): RW.CheckRow => ({ sha, name, state });

/**
 * A fake host: the PR, its comments and its check rows are set by the test. checks() returns
 * EVERY row it holds, whatever sha is asked for, like a source that is not bound to one
 * commit: only ciAtHead() keeps the head's rows.
 */
function fakeHost(head = H1, rows: RW.CheckRow[] = [green(H1)]) {
  const st = { head, rows, comments: [] as { body: string }[], prState: "OPEN", t: 1_000_000 };
  const calls = { dispatch: [] as RW.DispatchSpec[], pr: 0 };
  const host: RW.Host = {
    now: () => st.t,
    sleep: async (ms) => {
      st.t += ms / 1000;
    },
    pr: () => {
      calls.pr += 1;
      return { headRefOid: st.head, state: st.prState, comments: st.comments };
    },
    checks: () => st.rows,
    which: (c) => (c === "missing-bin" ? null : `/usr/bin/${c}`),
    dispatch: (d) => {
      calls.dispatch.push(d);
      return { pid: 4242 };
    },
  };
  return { host, st, calls };
}

const agent = (name: string, vendor: string | null = null, account: string | null = null): RW.ReviewAgent =>
  ({ name, argv: [`${name}-cli`, "--pr", "{pr}", "--head", "{head}", "--prompt", "{prompt}"], shell: null, vendor, account });

function settings(extra: Partial<RW.WatchSettings> = {}): RW.WatchSettings {
  return { requireCi: true, staleMinutes: 30, pollSeconds: 60, dir: join(tmp("orch-rw-"), "state"), ...extra };
}

function input(agents: RW.ReviewAgent[], extra: Partial<RW.WatchInput> = {}): RW.WatchInput {
  return { pr: 7, repo: "acme/widgets", authors: ["w1"], agents, profile: null, settings: settings(), ...extra };
}

/** A profile from TOML text: compute, people and the accounts/agents tables. */
function profile(compute: P.Compute, people: P.People, accounts: Record<string, string>, agents: Record<string, string>, extra = ""): P.Profile {
  const acc = Object.entries(accounts).map(([k, v]) => `${k} = "${v}"`).join("\n");
  const ag = Object.entries(agents).map(([k, v]) => `${k} = "${v}"`).join("\n");
  const text = `[profile]\ncompute = "${compute}"\npeople = "${people}"\nteammates = ["mate"]\n${extra}\n[profile.accounts]\n${acc}\n\n[profile.agents]\n${ag}\n`;
  return P.readProfile(parseToml(text))!;
}

const choose = (agents: RW.ReviewAgent[], prof: P.Profile | null, authors = ["w1"], tierFlag: P.Tier | null = null) =>
  RW.chooseReviewer({ agents, profile: prof, authors, tierFlag, files: [], which: (c) => (c === "missing-bin" ? null : `/usr/bin/${c}`) });

describe("ReviewWatchCi", () => {
  it("ci_green_pending_failed_none_at_the_head", () => {
    expect(RW.ciAtHead(H1, [green(H1), row(H1, "NEUTRAL", "lint"), row(H1, "SKIPPED", "docs")]).state).toBe("green");
    expect(RW.ciAtHead(H1, [green(H1), row(H1, "IN_PROGRESS", "test")])).toEqual({ state: "pending", bad: ["test=IN_PROGRESS"] });
    expect(RW.ciAtHead(H1, [green(H1), row(H1, "QUEUED", "test")]).state).toBe("pending");
    expect(RW.ciAtHead(H1, [row(H1, "PENDING", "ci/legacy")]).state).toBe("pending");
    expect(RW.ciAtHead(H1, [green(H1), row(H1, "FAILURE", "test"), row(H1, "PENDING", "e2e")])).toEqual({ state: "failed", bad: ["test=FAILURE"] });
    for (const s of ["ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "cancelled"]) {
      expect(RW.ciAtHead(H1, [row(H1, s)]).state, s).toBe("failed");
    }
    expect(RW.ciAtHead(H1, [])).toEqual({ state: "none", bad: [] });
  });

  it("a_green_older_commit_never_makes_the_head_green", () => {
    // only an older commit has checks: the head has none
    expect(RW.ciAtHead(H2, [green(H1)]).state).toBe("none");
    // the older commit is green, the head is still running
    expect(RW.ciAtHead(H2, [green(H1), row(H2, "IN_PROGRESS")]).state).toBe("pending");
    // the older commit failed, the head is green: the head decides
    expect(RW.ciAtHead(H2, [row(H1, "FAILURE"), green(H2)]).state).toBe("green");
    // sha case does not matter
    expect(RW.ciAtHead(H1, [green(H1.toUpperCase())]).state).toBe("green");
  });

  it("pending_failed_or_no_checks_mean_no_dispatch", () => {
    for (const rows of [[row(H1, "IN_PROGRESS")], [row(H1, "FAILURE")], [] as RW.CheckRow[], [green(H2)]]) {
      const f = fakeHost(H1, rows);
      const r = RW.watchOnce(input([agent("r1")]), f.host);
      expect(r.outcome, JSON.stringify(rows)).toBe("WAITING");
      expect(f.calls.dispatch).toEqual([]);
    }
    const f = fakeHost(H1, []);
    expect(RW.watchOnce(input([agent("r1")]), f.host).detail).toContain("require_ci = false");
  });

  it("no_checks_dispatch_only_with_require_ci_false", () => {
    const f = fakeHost(H1, []);
    const r = RW.watchOnce(input([agent("r1")], { settings: settings({ requireCi: false }) }), f.host);
    expect([r.outcome, r.ci, f.calls.dispatch.length]).toEqual(["DISPATCHED", "none", 1]);
    // require_ci = false never lets a pending or failed check through
    for (const rows of [[row(H1, "IN_PROGRESS")], [row(H1, "FAILURE")]]) {
      const g = fakeHost(H1, rows);
      expect(RW.watchOnce(input([agent("r1")], { settings: settings({ requireCi: false }) }), g.host).outcome).toBe("WAITING");
      expect(g.calls.dispatch).toEqual([]);
    }
  });

  it("green_at_the_head_dispatches_once_with_the_values", () => {
    const f = fakeHost();
    const inp = input([agent("r1", "codex")]);
    const r = RW.watchOnce(inp, f.host);
    expect(r.outcome).toBe("DISPATCHED");
    expect(f.calls.dispatch.length).toBe(1);
    const d = f.calls.dispatch[0];
    const prompt = join(inp.settings.dir, `review-7-${H1.slice(0, 12)}.prompt.md`);
    expect(d.worker).toBe(`review-7-${H1.slice(0, 12)}`);
    expect(d.argv).toEqual(["r1-cli", "--pr", "7", "--head", H1, "--prompt", prompt]);
    expect(d.env).toEqual({ ORCH_AGENT: "r1", ORCH_REVIEW_PR: "7", ORCH_REVIEW_HEAD: H1, ORCH_REVIEW_REPO: "acme/widgets", ORCH_REVIEW_PROMPT: prompt });
    expect(d.minutes).toBe(30);
    const text = readFileSync(prompt, "utf8");
    expect(text).toContain(`orch review approve 7 --as r1 --head ${H1} --repo acme/widgets`);
    expect(text).toContain(`ORCH-REVIEW APPROVE|CHANGES ${H1} by r1`);
    expect(text).toContain("Do not push, merge");
  });

  it("a_closed_pr_or_a_bad_repo_is_blocked", () => {
    const f = fakeHost();
    f.st.prState = "MERGED";
    expect(RW.watchOnce(input([agent("r1")]), f.host).outcome).toBe("BLOCKED");
    expect(RW.watchOnce(input([agent("r1")], { repo: "not a repo" }), fakeHost().host).outcome).toBe("BLOCKED");
    expect(RW.watchOnce(input([agent("r1")], { authors: [] }), fakeHost().host).outcome).toBe("BLOCKED");
    expect(f.calls.dispatch).toEqual([]);
  });
});

describe("ReviewWatchChoice", () => {
  // agents: w1 is the author on account a1; r1 shares a1; r2 is another account of the same vendor; r3 another vendor
  const A1 = { a1: "claude" };
  const SAME = { a1: "claude", a2: "claude" };
  const MULTI = { a1: "claude", a2: "claude", a3: "codex" };
  const MAP = { w1: "a1", r1: "a1", r2: "a2", r3: "a3" };
  const r1 = agent("r1");
  const r2 = agent("r2");
  const r3 = agent("r3");

  it("cell_A_one_account_solo_gives_a_labelled_single_agent_review", () => {
    const c = choose([r1], profile("one", "solo", A1, { w1: "a1", r1: "a1" }));
    expect([c.cell, c.need, c.pick?.name, c.pick?.label]).toEqual(["A", "single-agent", "r1", "single-agent (fresh context)"]);
  });

  it("cell_B_same_vendor_solo_prefers_cross_account_and_blocks_on_the_author_account_only", () => {
    const p = profile("same-vendor", "solo", SAME, { w1: "a1", r1: "a1", r2: "a2" });
    const c = choose([r1, r2], p);
    expect([c.cell, c.need, c.pick?.name, c.pick?.label]).toEqual(["B", "cross-account", "r2", "cross-account"]);
    const only = choose([r1], p);
    expect(only.pick).toBeNull();
    expect(only.reason).toContain("r1, is single-agent (fresh context); profile B at tier high needs cross-account");
  });

  it("cell_C_multi_vendor_solo_prefers_cross_vendor_and_the_tier_decides_the_fallback", () => {
    const p = profile("multi-vendor", "solo", MULTI, MAP);
    const c = choose([r1, r2, r3], p);
    expect([c.cell, c.pick?.name, c.pick?.label]).toEqual(["C", "r3", "cross-vendor"]);
    // high tier needs another vendor: a same-vendor reviewer is BLOCKED, never dispatched
    const high = choose([r1, r2], p, ["w1"], "high");
    expect([high.need, high.pick]).toEqual(["cross-vendor", null]);
    expect(high.reason).toContain("Add a reviewer on another vendor");
    // low tier: cross-account is enough
    const low = choose([r1, r2], p, ["w1"], "low");
    expect([low.need, low.pick?.name, low.pick?.label]).toEqual(["cross-account", "r2", "cross-account"]);
    expect(choose([r1], p, ["w1"], "low").pick).toBeNull();
  });

  it("cell_D_one_account_team_gives_a_labelled_single_agent_review", () => {
    const c = choose([r1], profile("one", "team", A1, { w1: "a1", r1: "a1" }));
    expect([c.cell, c.need, c.pick?.name, c.pick?.label]).toEqual(["D", "single-agent", "r1", "single-agent (fresh context)"]);
  });

  it("cell_E_same_vendor_team_prefers_cross_account_and_blocks_on_the_author_account_only", () => {
    const p = profile("same-vendor", "team", SAME, { w1: "a1", r1: "a1", r2: "a2" });
    expect([choose([r1, r2], p).cell, choose([r1, r2], p).pick?.name]).toEqual(["E", "r2"]);
    expect(choose([r1], p, ["w1"], "low").pick).toBeNull();
  });

  it("cell_F_multi_vendor_team_needs_another_vendor_even_at_low_tier", () => {
    const p = profile("multi-vendor", "team", MULTI, MAP);
    expect([choose([r2, r3], p, ["w1"], "low").cell, choose([r2, r3], p, ["w1"], "low").pick?.name]).toEqual(["F", "r3"]);
    const low = choose([r1, r2], p, ["w1"], "low");
    expect([low.need, low.pick]).toEqual(["cross-vendor", null]);
  });

  it("a_degraded_profile_follows_the_effective_cell", () => {
    // same-vendor declared with one account: the rule is cell A's, so a single-agent review is allowed and labelled
    const c = choose([r1], profile("same-vendor", "solo", A1, { w1: "a1", r1: "a1" }));
    expect([c.cell, c.pick?.name, c.pick?.label]).toEqual(["A", "r1", "single-agent (fresh context)"]);
  });

  it("the_author_is_never_chosen", () => {
    const p = profile("one", "solo", A1, { w1: "a1", r1: "a1" });
    // the author is first in config order and ties with r1: it is still skipped
    const c = choose([agent("w1"), r1], p);
    expect([c.pick?.name, c.excluded]).toEqual(["r1", ["w1"]]);
    // names compare case-insensitively
    expect(choose([agent("W1"), r1], p).pick?.name).toBe("r1");
    // a hand-off: every holder is an author, even the strongest reviewer
    const m = profile("multi-vendor", "solo", MULTI, MAP);
    const h = choose([r3, r2], m, ["w1", "r3"], "low");
    expect([h.pick?.name, h.excluded]).toEqual(["r2", ["r3"]]);
    // only the author is configured: BLOCKED with the reason, never a self-review
    const only = choose([agent("w1")], p);
    expect(only.pick).toBeNull();
    expect(only.reason).toContain("every configured reviewer is an author");
    // through watchOnce: nothing is started
    const f = fakeHost();
    expect(RW.watchOnce(input([agent("w1")], { profile: p }), f.host).outcome).toBe("BLOCKED");
    expect(f.calls.dispatch).toEqual([]);
  });

  it("without_a_profile_the_declared_vendor_and_account_rank_the_reviewers", () => {
    // the author w1 is a declared review agent too, so its vendor and account are known
    const agents = [agent("w1", "claude", "a1"), agent("s1", "claude", "a1"), agent("s2", "claude", "a2"), agent("x1", "codex", "a3")];
    expect([choose(agents, null).pick?.name, choose(agents, null).pick?.label, choose(agents, null).need]).toEqual(["x1", "cross-vendor", null]);
    expect(choose(agents.slice(0, 3), null).pick?.label).toBe("cross-account");
    expect(choose(agents.slice(0, 2), null).pick?.label).toBe("single-agent (fresh context)");
    // nothing declared: unmapped, first in config order
    expect([choose([r1, r2], null).pick?.name, choose([r1, r2], null).pick?.label]).toEqual(["r1", "single-agent (unmapped)"]);
  });

  it("a_reviewer_whose_command_is_missing_is_skipped", () => {
    const missing: RW.ReviewAgent = { ...r3, argv: ["missing-bin"] };
    const p = profile("multi-vendor", "solo", MULTI, MAP);
    const c = choose([missing, r2], p, ["w1"], "low");
    expect([c.pick?.name, c.candidates.find((x) => x.name === "r3")?.available]).toEqual(["r2", false]);
    expect(choose([missing], p, ["w1"], "low").reason).toContain("no reviewer command found on PATH (r3)");
    expect(choose([], null).reason).toContain("no reviewer configured");
  });
});

describe("ReviewWatchState", () => {
  it("one_dispatch_per_head_then_the_posted_line_is_verified", () => {
    const f = fakeHost();
    const inp = input([agent("r1")]);
    expect(RW.watchOnce(inp, f.host).outcome).toBe("DISPATCHED");
    // later passes at the same head start nothing
    for (let i = 0; i < 3; i++) expect(RW.watchOnce(inp, f.host).outcome).toBe("DISPATCHED");
    expect(f.calls.dispatch.length).toBe(1);
    // a line by r1 for another commit, or by another agent for the head, does not count
    f.st.comments = [{ body: `ORCH-REVIEW APPROVE ${H2} by r1` }, { body: `ORCH-REVIEW APPROVE ${H1} by r9` }];
    const w = RW.watchOnce(inp, f.host);
    expect(w.outcome).toBe("DISPATCHED");
    expect(w.detail).toContain("1 line(s) by r1 name another commit");
    f.st.comments.push({ body: `ORCH-REVIEW CHANGES ${H1} by R1\n\nneeds a test` });
    const r = RW.watchOnce(inp, f.host);
    expect([r.outcome, r.detail]).toEqual(["REVIEWED", `ORCH-REVIEW CHANGES ${H1} by r1 (single-agent (unmapped))`]);
    const rec = RW.readRec(RW.statePath(inp.settings.dir, "acme/widgets", 7))!;
    expect([rec.status, rec.verdict, rec.head, rec.agent, rec.pid]).toEqual(["reviewed", "CHANGES", H1, "r1", 4242]);
    expect(RW.watchOnce(inp, f.host).outcome).toBe("REVIEWED");
    expect(f.calls.dispatch.length).toBe(1);
  });

  it("a_new_head_gets_a_new_reviewer", () => {
    const f = fakeHost();
    const inp = input([agent("r1")]);
    RW.watchOnce(inp, f.host);
    f.st.comments = [{ body: `ORCH-REVIEW APPROVE ${H1} by r1` }];
    expect(RW.watchOnce(inp, f.host).outcome).toBe("REVIEWED");
    // push: the new head's CI is still running, so nothing starts yet
    f.st.head = H2;
    f.st.rows = [green(H1), row(H2, "IN_PROGRESS")];
    expect(RW.watchOnce(inp, f.host).outcome).toBe("WAITING");
    expect(f.calls.dispatch.length).toBe(1);
    f.st.rows = [green(H1), green(H2)];
    const r = RW.watchOnce(inp, f.host);
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.detail).toContain(`replaces r1 at ${H1.slice(0, 9)} (head moved)`);
    expect(f.calls.dispatch.map((d) => d.env.ORCH_REVIEW_HEAD)).toEqual([H1, H2]);
    const rec = RW.readRec(RW.statePath(inp.settings.dir, "acme/widgets", 7))!;
    expect([rec.head, rec.status, rec.history]).toEqual([H2, "dispatched", [{ head: H1, agent: "r1", status: "reviewed" }]]);
    // the approval of the old head does not review the new one
    expect(RW.watchOnce(inp, f.host).outcome).toBe("DISPATCHED");
  });

  it("a_reviewer_that_posts_nothing_goes_stale_and_doctor_lists_it", () => {
    const f = fakeHost();
    const inp = input([agent("r1")], { settings: settings({ staleMinutes: 10 }) });
    RW.watchOnce(inp, f.host);
    f.st.t += 9 * 60;
    expect(RW.watchOnce(inp, f.host).outcome).toBe("DISPATCHED");
    const cfg = { review: { watch: { dir: inp.settings.dir } } };
    // past its time but not yet re-checked: doctor already reports it
    f.st.t += 60;
    const late = RW.doctorRows(cfg, f.st.t);
    expect(late.map(([ok, name]) => [ok, name])).toEqual([[false, "review watch acme/widgets#7"]]);
    const r = RW.watchOnce(inp, f.host);
    expect([r.outcome, r.detail]).toEqual(["STALE", `r1 posted no review line for ${H1.slice(0, 9)} within 10m; \`--force\` starts another reviewer`]);
    expect(RW.readRec(RW.statePath(inp.settings.dir, "acme/widgets", 7))!.status).toBe("stale");
    expect(RW.doctorRows(cfg, f.st.t)[0][2]).toContain("r1 posted no review line");
    // stale stays stale: no second reviewer at this head without --force
    expect(RW.watchOnce(inp, f.host).outcome).toBe("STALE");
    expect(f.calls.dispatch.length).toBe(1);
    expect(RW.watchOnce({ ...inp, force: true }, f.host).detail).toContain("--force: replaces r1 (stale)");
    expect(f.calls.dispatch.length).toBe(2);
  });

  it("dry_run_starts_nothing_and_writes_nothing", () => {
    const f = fakeHost();
    const inp = input([agent("r1", "codex")], { dryRun: true });
    const r = RW.watchOnce(inp, f.host);
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.detail).toContain("dry run: would start r1");
    expect(r.command).toEqual(["r1-cli", "--pr", "7", "--head", H1, "--prompt", join(inp.settings.dir, `review-7-${H1.slice(0, 12)}.prompt.md`)]);
    expect(RW.renderResult(r).split("\n").slice(1)).toEqual([
      "reviewer: r1 single-agent (unmapped) vendor=codex",
      `command: ["r1-cli", "--pr", "7", "--head", "${H1}", "--prompt", "${join(inp.settings.dir, `review-7-${H1.slice(0, 12)}.prompt.md`)}"]`,
    ]);
    // CI pending: still shows the reviewer and the command
    f.st.rows = [row(H1, "QUEUED")];
    const w = RW.watchOnce(inp, f.host);
    expect([w.outcome, w.command !== null]).toEqual(["WAITING", true]);
    expect(f.calls.dispatch).toEqual([]);
    expect(existsSync(inp.settings.dir)).toBe(false);
  });

  it("a_shell_command_gets_its_values_only_from_the_environment", () => {
    const a: RW.ReviewAgent = { name: "r1", argv: null, shell: "my-reviewer --pr {pr} \"$ORCH_REVIEW_PR\"", vendor: null, account: null };
    expect(RW.commandFor(a, { pr: 7, head: H1, repo: "acme/widgets", prompt: "/p" })).toEqual(["/bin/sh", "-c", "my-reviewer --pr {pr} \"$ORCH_REVIEW_PR\""]);
  });
});

describe("ReviewWatchConfig", () => {
  it("reads_agents_and_settings_and_rejects_bad_values", () => {
    const cfg = parseToml(`[review]\nsource = "comments"\n\n[review.watch]\nrequire_ci = false\nstale_minutes = 5\n\n` +
      `[review.agents.x1]\ncmd = ["codex", "exec", "-"]\nvendor = "Codex"\naccount = "a3"\n\n[review.agents.s2]\ncmd = "claude -p < \\"$ORCH_REVIEW_PROMPT\\""\n`);
    expect(RW.readAgents(cfg)).toEqual([
      { name: "x1", argv: ["codex", "exec", "-"], shell: null, vendor: "codex", account: "a3" },
      { name: "s2", argv: null, shell: "claude -p < \"$ORCH_REVIEW_PROMPT\"", vendor: null, account: null },
    ]);
    expect(RW.readSettings(cfg)).toMatchObject({ requireCi: false, staleMinutes: 5, pollSeconds: 60 });
    const bad = (t: string) => () => {
      const c = parseToml(t);
      RW.readAgents(c);
      RW.readSettings(c);
    };
    expect(bad(`[review.agents.x]\ncmd = []\n`)).toThrow(/cmd must be/);
    expect(bad(`[review.agents.x]\ncmd = "x"\nmodel = "y"\n`)).toThrow(/unknown key 'model'/);
    expect(bad(`[review.agents.x]\ncmd = "x"\n\n[review.agents.X]\ncmd = "y"\n`)).toThrow(/differ only in case/);
    expect(bad(`[review.watch]\nrequire_ci = "no"\n`)).toThrow(/require_ci must be true or false/);
    expect(bad(`[review.watch]\nstale_minutes = 0\n`)).toThrow(/stale_minutes/);
    expect(bad(`[review.watch]\nevery = 1\n`)).toThrow(/unknown key 'every'/);
    // a vendor that contradicts [profile.accounts] is a config error, not a silent pick
    const p = profile("multi-vendor", "solo", { a1: "claude", a3: "codex" }, { w1: "a1" });
    expect(() => choose([agent("x1", "claude", "a3")], p)).toThrow(/is on 'codex'/);
  });
});

describe("ReviewWatchCli", () => {
  const ctx = useTmpHome();
  afterEach(() => {
    RW.override.host = null;
  });

  const config = (extra = "") => writeFileSync(join(ctx.home, "config.toml"),
    `[merge]\nrepo = "acme/widgets"\n\n[review.agents.r1]\ncmd = ["r1-cli", "{pr}", "{head}"]\nvendor = "codex"\n${extra}`);

  it("cli_needs_a_task_a_pr_number_and_a_profile_for_tier", async () => {
    config();
    let [code, out] = await run("review", "watch", "7");
    expect([code, out.trim()]).toEqual([1, "#7 => BLOCKED (review watch needs --task ID: the task whose holder authored this PR, so the author is never its reviewer)"]);
    let err: string;
    [code, , err] = await run("review", "watch", "7x", "--task", "t");
    expect([code, err.trim()]).toEqual([2, "review watch: bad PR number '7x'"]);
    [code, , err] = await run("review", "watch", "7", "--task", "t", "--tier", "low");
    expect(code).toBe(2);
    expect(err).toContain("--tier needs a [profile] table");
    // a task nobody claimed: the author is unknown, so nothing starts
    const f = fakeHost();
    RW.override.host = f.host;
    [code, out] = await run("review", "watch", "7", "--task", "nobody", "--once");
    expect(code).toBe(1);
    expect(out).toContain("BLOCKED (the PR's task has no recorded holder");
    expect(f.calls.dispatch).toEqual([]);
    // a bad [review.agents] value exits 2 like any config error
    writeFileSync(join(ctx.home, "config.toml"), `[review.agents.r1]\ncmd = 3\n`);
    [code, , err] = await run("review", "watch", "7", "--task", "t");
    expect(code).toBe(2);
    expect(err).toContain("[review.agents.r1] cmd must be");
  });

  it("cli_dry_run_prints_the_reviewer_and_command_and_starts_nothing", async () => {
    config();
    await run("task", "claim", "fix-7", "--as", "w1");
    const f = fakeHost();
    RW.override.host = f.host;
    const [code, out] = await run("review", "watch", "7", "--task", "fix-7", "--dry-run");
    expect(code).toBe(0);
    expect(out).toBe(`#7 head=111111111 ci=green => DISPATCHED (dry run: would start r1 (single-agent (unmapped)); nothing was run)\n` +
      `reviewer: r1 single-agent (unmapped) vendor=codex\ncommand: ["r1-cli", "7", "${H1}"]\n`);
    expect(f.calls.dispatch).toEqual([]);
    expect(existsSync(join(ctx.home, "review-watch"))).toBe(false);
  });

  it("cli_loop_waits_for_ci_dispatches_and_stops_when_reviewed", async () => {
    config();
    await run("task", "claim", "fix-7", "--as", "w1");
    const f = fakeHost(H1, [row(H1, "IN_PROGRESS")]);
    const baseSleep = f.host.sleep;
    let passes = 0;
    f.host.sleep = async (ms) => {
      passes += 1;
      if (passes === 1) f.st.rows = [green(H1)];
      if (passes === 3) f.st.comments = [{ body: `ORCH-REVIEW APPROVE ${H1} by r1` }];
      await baseSleep(ms);
    };
    RW.override.host = f.host;
    const [code, out] = await run("review", "watch", "7", "--task", "fix-7", "--interval", "1");
    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines.map((l) => l.split(" => ")[1].split(" ")[0])).toEqual(["WAITING", "DISPATCHED", "DISPATCHED", "REVIEWED"]);
    expect(lines[3]).toBe(`#7 head=111111111 => REVIEWED (ORCH-REVIEW APPROVE ${H1} by r1 (single-agent (unmapped)))`);
    expect(f.calls.dispatch.length).toBe(1);
    // --once on a reviewed head: exit 0, nothing new
    const [c2, o2] = await run("review", "watch", "7", "--task", "fix-7", "--once", "--json");
    expect([c2, JSON.parse(o2).outcome, f.calls.dispatch.length]).toEqual([0, "REVIEWED", 1]);
  });

  it("cli_loop_timeout_exits_1", async () => {
    config();
    await run("task", "claim", "fix-7", "--as", "w1");
    const f = fakeHost(H1, [row(H1, "QUEUED")]);
    RW.override.host = f.host;
    const [code, out] = await run("review", "watch", "7", "--task", "fix-7", "--interval", "30", "--timeout", "100");
    expect(code).toBe(1);
    expect(out.trim().split("\n").length).toBe(1);
    expect(f.calls.pr).toBe(4);
  });

  it("doctor_lists_review_agents_only_when_configured", async () => {
    await run("init", "--no-handbook");
    let [, out] = await run("doctor");
    expect(out).not.toContain("review agent");
    expect(out).not.toContain("review watch");
    const text = readFileSync(join(ctx.home, "config.toml"), "utf8");
    writeFileSync(join(ctx.home, "config.toml"), text + `\n[review.agents.r1]\ncmd = ["missing-reviewer-cli-xyz"]\n`);
    [, out] = await run("doctor");
    expect(out).toMatch(/SKIP\s+review agent r1\s+'missing-reviewer-cli-xyz' not on PATH/);
  });
});

describe("ReviewWatchDispatch", () => {
  useAttendedTerminal();
  it("worker_start_passes_the_review_environment_and_the_prompt_on_stdin", async () => {
    const root = tmp("orch-rw-w-");
    const out = join(root, "seen.txt");
    const prompt = join(root, "p.md");
    writeFileSync(prompt, "review this\n");
    const w = new Workers({ workers: { nice: 0 } }, join(root, "workers"), join(root, "load.json"));
    w.start("review-7-abc", {
      command: ["/bin/sh", "-c", `{ echo "$ORCH_AGENT $ORCH_REVIEW_PR $ORCH_REVIEW_HEAD"; cat; } > "${out}"`],
      task: prompt, minutes: 0, env: { ORCH_AGENT: "r1", ORCH_REVIEW_PR: "7", ORCH_REVIEW_HEAD: H1 },
    });
    expect(await waitFor(() => existsSync(out) && readFileSync(out, "utf8").includes("review this"))).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(`r1 7 ${H1}\nreview this\n`);
  });
});
