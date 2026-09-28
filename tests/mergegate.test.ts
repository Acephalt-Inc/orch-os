// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from "vitest";
import * as M from "../src/mergegate.js";

const OK = M.loadFixture("approved") as Record<string, any>;
const HEAD: string = OK.headRefOid;
const copy = <T>(x: T): T => structuredClone(x);

function rv(who: string, state: string, oid = HEAD) {
  return { author: { login: who }, state, commit: { oid } };
}

describe("MergeGateTest", () => {
  it("test_approved_at_head_passes", () => {
    const r = M.evaluate(OK);
    expect(r.ok).toBe(true);
    expect(r.approvals).toBe(1);
  });

  it("test_approval_of_older_commit_is_stale", () => {
    const r = M.evaluate(M.loadFixture("stale-approval"));
    expect(r.ok).toBe(false);
    expect([r.approvals, r.stale]).toEqual([0, 1]);
  });

  it("test_author_approval_never_counts", () => {
    const r = M.evaluate(M.loadFixture("self-approval"));
    expect(r.ok).toBe(false);
    expect(r.self).toBe(1);
  });

  it("test_changes_requested_blocks_even_with_approval", () => {
    const r = M.evaluate(M.loadFixture("changes-requested"));
    expect(r.ok).toBe(false);
    expect([r.approvals, r.changes_requested]).toEqual([1, 1]);
  });

  it("test_later_approval_replaces_changes_requested", () => {
    const info = copy(OK);
    info.reviews = [rv("carol", "CHANGES_REQUESTED"), rv("carol", "APPROVED")];
    expect(M.evaluate(info).ok).toBe(true);
  });

  it("test_dismissed_clears_and_commented_is_ignored", () => {
    const info = copy(OK);
    info.reviews = [rv("bob", "APPROVED"), rv("bob", "DISMISSED"), rv("carol", "COMMENTED")];
    expect(M.evaluate(info).approvals).toBe(0);
  });

  it("test_ci_red_and_no_checks_block", () => {
    expect(M.evaluate(M.loadFixture("ci-red")).ok).toBe(false);
    const info = copy(OK);
    info.statusCheckRollup = [];
    expect(M.evaluate(info).ok).toBe(false);
    info.statusCheckRollup = [{ name: "docs", conclusion: "SKIPPED" }, { name: "t", conclusion: "SUCCESS" }];
    expect(M.evaluate(info).ok).toBe(true);
  });

  it("test_required_approvals_threshold", () => {
    expect(M.evaluate(OK, { requiredApprovals: 2 }).ok).toBe(false);
    const info = copy(OK);
    info.reviews.push(rv("carol", "APPROVED"));
    expect(M.evaluate(info, { requiredApprovals: 2 }).ok).toBe(true);
  });

  it("test_label_is_off_by_default_and_enforced_when_set", () => {
    expect(M.evaluate(OK).ok).toBe(true);
    expect(M.evaluate(OK, { requiredLabel: "ready" }).ok).toBe(false);
    const info = copy(OK);
    info.labels = [{ name: "ready" }];
    expect(M.evaluate(info, { requiredLabel: "ready" }).ok).toBe(true);
  });

  it("test_bad_head_blocks", () => {
    const info = copy(OK);
    info.headRefOid = "abc";
    const r = M.evaluate(info);
    expect(r.ok).toBe(false);
    expect(M.render("1", r)).toContain("BLOCKED");
  });

  it("test_explicit_head_override_makes_approval_stale", () => {
    expect(M.evaluate(OK, { head: "0".repeat(40) }).ok).toBe(false);
  });

  it("test_duplicate_check_names_cannot_hide_a_failure", () => {
    const info = copy(OK);
    info.statusCheckRollup = [{ name: "test", conclusion: "FAILURE" }, { name: "test", conclusion: "SUCCESS" }];
    expect(M.evaluate(info).ok).toBe(false);
  });

  it("test_expected_head_guard_blocks_when_pr_moved", () => {
    const r = M.evaluate(OK, { head: "0".repeat(40) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("head moved");
    expect(M.evaluate(OK, { head: HEAD.slice(0, 12) }).ok).toBe(true);
  });
});

describe("MergeGateV2", () => {
  it("render_matches_v1_text", () => {
    expect(M.render("101", M.evaluate(OK))).toBe(
      "#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n=> PASS");
    expect(M.render("101", M.evaluate(M.loadFixture("ci-red")))).toBe(
      '#101 head=4f2c9a1e7 ci=NOT green {"tests": "FAILURE"} approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n=> BLOCKED');
    expect(M.render("7", M.evaluate(OK, { requiredLabel: "ready" }))).toContain("label=MISSING 'ready'");
  });

  it("malformed_pr_data_throws_so_the_cli_blocks", () => {
    for (const bad of [
      { ...OK, reviews: "not-a-list" },
      { ...OK, statusCheckRollup: { a: 1 } },
      { ...OK, headRefOid: 42 },
      { ...OK, author: "alice" },
      { ...OK, labels: ["ready"] },
      [1, 2, 3],
    ]) expect(() => M.evaluate(bad)).toThrow(TypeError);
  });

  it("workflow_names_and_status_contexts_are_read", () => {
    const info = copy(OK);
    info.statusCheckRollup = [{ workflowName: "ci", name: "unit", conclusion: "success" }, { context: "legacy", state: "PENDING" }];
    const r = M.evaluate(info);
    expect(r.ci_ok).toBe(false);
    expect(r.checks).toEqual({ legacy: "PENDING" });
  });

  it("fixture_names_are_listed", () => {
    expect(M.fixtureNames()).toEqual(["approved", "changes-requested", "ci-red", "self-approval", "stale-approval"]);
  });
});
