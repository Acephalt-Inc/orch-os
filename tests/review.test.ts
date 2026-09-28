// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Review source "comments": ORCH-REVIEW comments for agents that share one GitHub account.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/mergegate.js";
import { Lease } from "../src/lease.js";
import { Tasks } from "../src/tasks.js";
import { fakeBin, keepEnv, ROOT, run, tmp, useTmpHome } from "./_helpers.js";

const OK = M.loadFixture("approved") as Record<string, any>;
const HEAD: string = OK.headRefOid;
const OLD = "0123456789abcdef0123456789abcdef01234567";
const copy = <T>(x: T): T => structuredClone(x);

/** A comment whose body is the review comment line (plus optional text). */
function review(verdict: string, agent: string, sha = HEAD, extra = "") {
  return { author: { login: "alice" }, body: `ORCH-REVIEW ${verdict} ${sha} by ${agent}${extra}` };
}

/** The approved fixture, stripped of GitHub reviews, carrying these comments. */
function withComments(...comments: unknown[]) {
  const info = copy(OK);
  info.reviews = [];
  info.comments = comments;
  return info;
}

const gate = (info: unknown, authors = ["w1"], extra: M.GateOptions = {}) =>
  M.evaluate(info, { reviewSource: "comments", authorAgents: authors, ...extra });

describe("ReviewComments", () => {
  it("approve_comment_at_head_passes", () => {
    const r = gate(withComments(review("APPROVE", "r1")));
    expect(r.ok).toBe(true);
    expect([r.approvals, r.approved_by, r.stale, r.self, r.malformed]).toEqual([1, ["r1"], 0, 0, 0]);
    expect(M.render("7", r)).toBe(
      "#7 head=4f2c9a1e7 ci=green reviews=comments author=w1 approvals=1/1 [r1] (stale=0 self=0 malformed=0) changes_requested=0 label=off\n=> PASS");
  });

  it("stale_sha_comment_does_not_count", () => {
    const r = gate(withComments(review("APPROVE", "r1", OLD)));
    expect(r.ok).toBe(false);
    expect([r.approvals, r.stale]).toEqual([0, 1]);
    // a stale CHANGES does not block either: the new head needs a new review
    const r2 = gate(withComments(review("CHANGES", "r2", OLD), review("APPROVE", "r1")));
    expect([r2.ok, r2.changes_requested, r2.stale]).toEqual([true, 0, 1]);
  });

  it("same_agent_approval_is_rejected", () => {
    const r = gate(withComments(review("APPROVE", "w1")));
    expect(r.ok).toBe(false);
    expect([r.approvals, r.self]).toEqual([0, 1]);
    // names compare case-insensitively, like task ids
    expect(gate(withComments(review("APPROVE", "W1"))).self).toBe(1);
    // the holder before a hand-off is an author too
    const r3 = gate(withComments(review("APPROVE", "w0")), ["w1", "w0"]);
    expect([r3.ok, r3.self]).toEqual([false, 1]);
    // the GitHub login is never the identity: alice (PR author login) posting as r1 counts
    expect(gate(withComments(review("APPROVE", "r1"))).ok).toBe(true);
  });

  it("changes_after_approve_blocks", () => {
    const other = gate(withComments(review("APPROVE", "r1"), review("CHANGES", "r2")));
    expect([other.ok, other.approvals, other.changes_requested, other.blocked_by]).toEqual([false, 1, 1, ["r2"]]);
    const same = gate(withComments(review("APPROVE", "r1"), review("REJECT", "r1")));
    expect([same.ok, same.approvals, same.changes_requested]).toEqual([false, 0, 1]);
    // an approval after the same agent's CHANGES at the same head replaces it (latest per agent)
    expect(gate(withComments(review("CHANGES", "r1"), review("APPROVE", "r1"))).ok).toBe(true);
    // the author's own CHANGES is ignored like the author's own APPROVE
    expect(gate(withComments(review("APPROVE", "r1"), review("CHANGES", "w1"))).ok).toBe(true);
  });

  it("mixed_sources_do_not_cross", () => {
    // comments mode: a GitHub approval does not count
    const gh = gate(OK);
    expect([gh.ok, gh.approvals]).toEqual([false, 0]);
    // comments mode: a GitHub CHANGES_REQUESTED still blocks (fail closed)
    const cr = gate({ ...copy(M.loadFixture("changes-requested") as Record<string, any>), comments: [review("APPROVE", "r1")] });
    expect([cr.ok, cr.approvals, cr.github_changes_requested, cr.changes_requested]).toEqual([false, 1, 1, 1]);
    // github mode: review comments are ignored
    const rc = M.evaluate(M.loadFixture("comment-approved"));
    expect([rc.ok, rc.approvals]).toEqual([false, 0]);
    expect(gate(M.loadFixture("comment-approved")).ok).toBe(true);
  });

  it("malformed_first_line_is_counted_and_ignored", () => {
    const bad = [
      `ORCH-REVIEW APPROVE ${HEAD.slice(0, 12)} by r1`, // short sha
      `ORCH-REVIEW APPROVE ${HEAD.toUpperCase()} by r1`, // sha not lower case
      `ORCH-REVIEW approve ${HEAD} by r1`, // verdict case
      `ORCH-REVIEW LGTM ${HEAD} by r1`, // unknown verdict
      `ORCH-REVIEW APPROVE ${HEAD} by`, // no agent
      `ORCH-REVIEW APPROVE ${HEAD} by r1 and r2`, // trailing words
      `ORCH-REVIEW APPROVE ${HEAD} by r/1`, // agent name with a bad character
      `ORCH-REVIEW  APPROVE ${HEAD} by r1`, // two spaces
      ` ORCH-REVIEW APPROVE ${HEAD} by r1`, // leading space
      `orch-review APPROVE ${HEAD} by r1`, // prefix case
    ].map((body) => ({ body }));
    const notReviewLines = [
      { body: `LGTM\nORCH-REVIEW APPROVE ${HEAD} by r1` }, // review line on line 2
      { body: `\nORCH-REVIEW APPROVE ${HEAD} by r1` }, // empty first line
      { body: "" },
    ];
    const r = gate(withComments(...bad, ...notReviewLines));
    expect([r.ok, r.approvals, r.malformed]).toEqual([false, 0, bad.length]);
    // trailing whitespace (e.g. \r from a CRLF body) is tolerated; text after line 1 is free
    expect(gate(withComments({ body: `ORCH-REVIEW APPROVE ${HEAD} by r1 \r\nnotes` })).ok).toBe(true);
    expect(M.parseReviewLine(`ORCH-REVIEW CHANGES ${HEAD} by r2`)).toEqual({ verdict: "CHANGES", sha: HEAD, agent: "r2" });
    // a hand-typed block in the wrong case is shown as malformed, never counted (neither way)
    const lc = gate(withComments(review("APPROVE", "r1"), { body: `  orch-review CHANGES ${HEAD} by r2` }));
    expect([lc.ok, lc.approvals, lc.changes_requested, lc.malformed]).toEqual([true, 1, 0, 1]);
  });

  it("no_author_agent_blocks", () => {
    const r = gate(withComments(review("APPROVE", "r1")), []);
    expect(r.ok).toBe(false);
    expect(M.render("7", r)).toContain("BLOCKED (no author agent");
  });

  it("threshold_label_ci_and_head_guard_still_apply", () => {
    const two = withComments(review("APPROVE", "r1"), review("APPROVE", "r1"));
    expect(gate(two, ["w1"], { requiredApprovals: 2 }).ok).toBe(false); // one agent twice is one approval
    expect(gate(withComments(review("APPROVE", "r1"), review("APPROVE", "r2")), ["w1"], { requiredApprovals: 2 }).ok).toBe(true);
    expect(gate(withComments(review("APPROVE", "r1")), ["w1"], { requiredLabel: "ready" }).ok).toBe(false);
    const red = withComments(review("APPROVE", "r1"));
    red.statusCheckRollup = [{ name: "tests", conclusion: "FAILURE" }];
    expect(gate(red).ok).toBe(false);
    expect(gate(withComments(review("APPROVE", "r1")), ["w1"], { head: OLD }).reason).toContain("head moved");
  });

  it("malformed_comment_data_throws", () => {
    expect(() => gate({ ...withComments(), comments: "x" })).toThrow(M.PrDataError);
    expect(() => gate(withComments({ body: 5 }))).toThrow(M.PrDataError);
  });

  it("review_line_validates_and_round_trips", () => {
    const line = M.reviewLine("APPROVE", HEAD, "r1");
    expect(line).toBe(`ORCH-REVIEW APPROVE ${HEAD} by r1`);
    expect(M.parseReviewLine(line)).toEqual({ verdict: "APPROVE", sha: HEAD, agent: "r1" });
    expect(() => M.reviewLine("APPROVE", HEAD.slice(0, 9), "r1")).toThrow(RangeError);
    expect(() => M.reviewLine("APPROVE", HEAD, "has space")).toThrow(RangeError);
  });
});

describe("GithubSourceUnchanged", () => {
  const snap = JSON.parse(readFileSync(join(ROOT, "tests", "snapshots", "merge-gate-github-v2.0.1.json"), "utf8")).cases as Record<string, { out: string; code: number }>;
  useTmpHome();

  it("cli_output_matches_the_v2_0_1_snapshot_byte_for_byte", async () => {
    expect(Object.keys(snap).length).toBe(20);
    for (const [key, want] of Object.entries(snap)) {
      const [fixture, fmt, head] = key.split(" ");
      const argv = ["merge-gate", "101", "--fixture", fixture, ...(head === "head-moved" ? ["--head", "0000000"] : []), ...(fmt === "json" ? ["--json"] : [])];
      for (const extra of [[], ["--reviews", "github"]]) {
        const [code, out] = await run(...argv, ...extra);
        expect(out, `${key} ${extra.join(" ")}`).toBe(want.out);
        expect(code, key).toBe(want.code);
      }
    }
  });

  it("explicit_github_source_equals_the_default", () => {
    for (const f of M.fixtureNames()) {
      const info = M.loadFixture(f);
      expect(M.evaluate(info, { reviewSource: "github", authorAgents: ["bob"] })).toEqual(M.evaluate(info));
    }
  });

  it("live_fields_unchanged_for_github", () => {
    expect(M.liveFields()).toBe("author,headRefOid,reviews,labels,statusCheckRollup");
    expect(M.liveFields("github")).toBe("author,headRefOid,reviews,labels,statusCheckRollup");
    expect(M.liveFields("comments")).toBe("author,headRefOid,reviews,labels,statusCheckRollup,comments");
  });
});

describe("ReviewCli", () => {
  const ctx = useTmpHome();
  keepEnv(["PATH", "ORCH_TEST_OUT", "ORCH_TEST_JSON"]);
  let bins = "";
  beforeEach(() => {
    bins = tmp("orch-gh-");
    process.env.PATH = `${bins}:/usr/bin:/bin`;
    process.env.ORCH_TEST_OUT = join(bins, "argv.txt");
    // fake gh: records its argv one per line, prints $ORCH_TEST_JSON (if set) as the PR data
    fakeBin(bins, "gh", 'printf "%s\\n" "$@" > "$ORCH_TEST_OUT"; [ -n "$ORCH_TEST_JSON" ] && cat "$ORCH_TEST_JSON"; exit 0');
  });
  const ghArgv = () => readFileSync(process.env.ORCH_TEST_OUT!, "utf8").split("\n").slice(0, -1);
  const claim = (id: string, who: string) => new Tasks(join(ctx.home, "tasks")).claim(id, who);

  it("merge_gate_comments_mode_uses_the_task_holder", async () => {
    claim("fix-1", "w1");
    const fx = join(ROOT, "fixtures", "comment-approved.json");
    const [code, out] = await run("merge-gate", "101", "--fixture", fx, "--reviews", "comments", "--task", "fix-1");
    expect([code, out]).toEqual([0, "#101 head=4f2c9a1e7 ci=green reviews=comments author=w1 approvals=1/1 [r1] (stale=0 self=0 malformed=0) changes_requested=0 label=off\n=> PASS\n"]);
    // the reviewer holding the task makes its own review comment a self-review
    claim("fix-2", "r1");
    const [code2, out2] = await run("merge-gate", "101", "--fixture", fx, "--reviews", "comments", "--task", "fix-2");
    expect(code2).toBe(1);
    expect(out2).toContain("self=1");
  });

  it("every_past_holder_is_an_author", async () => {
    // r1 writes the PR and hands the task on twice: r1 -> alice -> carol. r1's own approval must not count.
    const t = new Tasks(join(ctx.home, "tasks"));
    for (const who of ["r1", "alice"]) {
      expect(t.claim("t3", who)[0]).toBe(0);
      expect(t.release("t3", who)[0]).toBe(0);
    }
    expect(t.claim("t3", "carol")[0]).toBe(0);
    expect(t.holders("t3")).toEqual(["r1", "alice", "carol"]);
    const [code, out] = await run("merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t3");
    expect([code, out]).toEqual([1, "#101 head=4f2c9a1e7 ci=green reviews=comments author=r1,alice,carol approvals=0/1 (stale=0 self=1 malformed=0) changes_requested=0 label=off\n=> BLOCKED\n"]);
  });

  it("holder_history_reads_old_task_files_and_stays_off_the_role_lease", () => {
    const dir = join(ctx.home, "tasks");
    mkdirSync(dir, { recursive: true });
    // a task file written before `holders` existed: previous_owner + session_id are both authors
    writeFileSync(join(dir, "old.json"), JSON.stringify({ acquired_at: 1, previous_owner: "w0", epoch: 2, state: "RELEASED", session_id: "w1", lease_expires_at: 0 }));
    const t = new Tasks(dir);
    expect(t.holders("old")).toEqual(["w0", "w1"]);
    expect(t.claim("old", "w2")[0]).toBe(0);
    expect(t.holders("old")).toEqual(["w0", "w1", "w2"]);
    // re-claiming your own task does not repeat you
    expect(t.claim("old", "w2")[0]).toBe(0);
    expect(t.holders("old")).toEqual(["w0", "w1", "w2"]);
    // the role lease file layout is unchanged: no holders key
    const [, r] = new Lease(join(ctx.home, "lease.json")).run("acquire", "a");
    expect("holders" in r.state).toBe(false);
  });

  it("large_gh_output_is_read_not_blocked", async () => {
    // > 1 MiB of PR JSON (a long comment thread) must not hit Node's default spawnSync buffer
    const big = structuredClone(M.loadFixture("comment-approved") as Record<string, any>);
    big.comments.unshift({ body: "long discussion " + "x".repeat(1_100_000) });
    const fx = join(bins, "big.json");
    writeFileSync(fx, JSON.stringify(big));
    expect(statSync(fx).size).toBeGreaterThan(1_100_000);
    process.env.ORCH_TEST_JSON = fx;
    claim("fix-1", "w1");
    const [code, out] = await run("merge-gate", "5", "--repo", "o/n", "--reviews", "comments", "--task", "fix-1");
    expect([code, out.split("\n").at(-2)]).toEqual([0, "=> PASS"]);
  });

  it("malformed_lines_warn_on_stderr", async () => {
    claim("fix-1", "w1");
    const info = structuredClone(M.loadFixture("comment-approved") as Record<string, any>);
    info.comments.push({ body: `orch-review CHANGES ${HEAD} by r2` });
    const fx = join(bins, "lc.json");
    writeFileSync(fx, JSON.stringify(info));
    const [code, out, err] = await run("merge-gate", "101", "--fixture", fx, "--reviews", "comments", "--task", "fix-1");
    expect(code).toBe(0);
    expect(out).toContain("malformed=1");
    expect(err).toBe("merge-gate: warning: 1 comment(s) look like ORCH-REVIEW lines but are malformed; they were not counted\n");
  });

  it("merge_gate_comments_mode_fails_closed_without_a_task_author", async () => {
    const [c1, o1] = await run("merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments");
    expect([c1, o1]).toEqual([1, "#101 => BLOCKED (comments mode needs --task ID: the task whose holder authored this PR)\n"]);
    const [c2, o2] = await run("merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "nobody");
    expect(c2).toBe(1);
    expect(o2).toContain("has no recorded holder");
    const [c3, o3] = await run("merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", ".bad");
    expect(c3).toBe(1);
    expect(o3).toContain("BLOCKED (bad task id");
  });

  it("config_review_source_selects_the_mode", async () => {
    claim("fix-1", "w1");
    const cfg = join(ctx.home, "config.toml");
    expect((await run("init"))[0]).toBe(0);
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain('[review]\n');
    writeFileSync(cfg, text.replace(/^source = "github"$/m, 'source = "comments"'));
    expect((await run("merge-gate", "101", "--fixture", "comment-approved", "--task", "fix-1"))[0]).toBe(0);
    expect((await run("merge-gate", "101", "--fixture", "comment-approved", "--task", "fix-1", "--reviews", "github"))[0]).toBe(1);
    writeFileSync(cfg, text.replace(/^source = "github"$/m, 'source = "gitlab"'));
    const [code, , err] = await run("merge-gate", "101", "--fixture", "approved");
    expect(code).toBe(2);
    expect(err).toContain('[review] source must be "github" or "comments"');
  });

  it("live_fetch_asks_gh_for_comments_only_in_comments_mode", async () => {
    process.env.ORCH_TEST_JSON = join(ROOT, "fixtures", "comment-approved.json");
    expect((await run("merge-gate", "5", "--repo", "o/n"))[0]).toBe(1);
    expect(ghArgv()).toEqual(["pr", "view", "5", "--repo", "o/n", "--json", "author,headRefOid,reviews,labels,statusCheckRollup"]);
    claim("fix-1", "w1");
    expect((await run("merge-gate", "5", "--repo", "o/n", "--reviews", "comments", "--task", "fix-1"))[0]).toBe(0);
    expect(ghArgv().at(-1)).toBe("author,headRefOid,reviews,labels,statusCheckRollup,comments");
  });

  it("review_command_posts_the_review_line", async () => {
    const [c1, o1] = await run("review", "approve", "5", "--as", "r1", "--head", HEAD, "--dry-run");
    expect([c1, o1]).toEqual([0, `ORCH-REVIEW APPROVE ${HEAD} by r1\n`]);
    const [c2, o2] = await run("review", "changes", "5", "--as", "r1", "--head", HEAD, "--repo", "o/n", "-m", "tests missing");
    expect([c2, o2]).toEqual([0, `posted on #5: ORCH-REVIEW CHANGES ${HEAD} by r1\n`]);
    expect(ghArgv()).toEqual(["pr", "comment", "5", "--repo", "o/n", "--body", `ORCH-REVIEW CHANGES ${HEAD} by r1`, "", "tests missing"]);
    // without --head, the live head is read through gh first
    process.env.ORCH_TEST_JSON = join(ROOT, "fixtures", "approved.json");
    const [c3, o3] = await run("review", "reject", "5", "--as", "r2", "--repo", "o/n", "--dry-run");
    expect([c3, o3]).toEqual([0, `ORCH-REVIEW REJECT ${HEAD} by r2\n`]);
    expect(ghArgv()).toEqual(["pr", "view", "5", "--repo", "o/n", "--json", "headRefOid"]);
  });

  it("review_command_refuses_bad_input", async () => {
    const [c1, , e1] = await run("review", "approve", "5", "--as", "r1", "--head", HEAD.slice(0, 9), "--dry-run");
    expect(c1).toBe(2);
    expect(e1).toContain("full 40-character commit sha");
    const [c2, , e2] = await run("review", "approve", "5", "--as", "r 1", "--head", HEAD, "--dry-run");
    expect(c2).toBe(2);
    expect(e2).toContain("bad agent name");
    expect((await run("review", "merge", "5"))[0]).toBe(2);
  });
});
