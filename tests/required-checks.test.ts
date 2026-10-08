// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ciVerdict, requiredCheckNames } from "../src/checks.js";
import * as M from "../src/mergegate.js";
import * as RW from "../src/reviewwatch.js";
import { ROOT } from "./_helpers.js";
import { HEAD, prData, scenarios } from "./fixtures/required-checks.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(ROOT, ".os2-policy-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RequiredChecksPolicy", () => {
  it.each(scenarios)("$title: gate and actual dispatch", (s) => {
    const requiredChecks = s.required ?? ["CI/test"];
    const info = prData(s);
    const gate = M.evaluate(info, { requiredChecks });
    expect(gate.ci_ok).toBe(s.gateGreen);
    expect(gate.ok).toBe(s.gateGreen);
    expect(M.evaluate(info, { requiredChecks, reviewSource: "comments", authorAgents: ["author"] }).ci_ok).toBe(s.gateGreen);
    if (s.gateReason) expect(Object.values(gate.unmet_checks)).toContain(s.gateReason);
    const rows = RW.checkRows(s.runs.map((r) => [r.sha, r.name, r.state, r.suite]), [], s.workflows);
    // require_ci=false and --force must never bypass a required check.
    const state = mkdtempSync(join(dir, "watch-"));
    const dispatch: RW.DispatchSpec[] = [];
    const host: RW.Host = {
      now: () => 1000, sleep: async () => {}, pr: () => info, checks: () => rows,
      which: () => "/bin/reviewer", dispatch: (d) => { dispatch.push(d); return { pid: 1234 }; },
    };
    const result = RW.watchOnce({
      pr: 7, repo: "acme/widgets", authors: ["author"], profile: null, requiredChecks,
      agents: [{ name: "reviewer", argv: ["reviewer"], shell: null, vendor: null, account: null }],
      settings: { requireCi: false, dir: state, pollSeconds: 60, staleMinutes: 30 }, force: true,
    }, host);
    expect(result.ci === "green").toBe(s.watchGreen);
    expect(result.outcome).toBe(s.watchGreen ? "DISPATCHED" : "WAITING");
    expect(dispatch.length).toBe(s.watchGreen ? 1 : 0);
    expect(existsSync(RW.statePath(state, "acme/widgets", 7))).toBe(s.watchGreen);
    if (s.watchReason) expect(result.detail).toContain(s.watchReason);
    if (!gate.ci_ok) expect(dispatch).toEqual([]);
  });

  it("no watch-green gate-red result across 26200 partial-list combinations", () => {
    const choices: { workflow: string; state: string; listed: boolean }[] = [];
    for (const workflow of ["CI", "Other", ""]) for (const state of ["SUCCESS", "SKIPPED", "NEUTRAL", "PENDING", "FAILURE"]) {
      for (const listed of workflow ? [true, false] : [false]) choices.push({ workflow, state, listed });
    }
    let cases = 0;
    const unsafe: unknown[] = [];
    const visit = (indices: number[]) => {
      const rows = indices.map((idx, suite) => ({ ...choices[idx], sha: HEAD, name: "test", suite }));
      const info = { ...prData(scenarios[0]), statusCheckRollup: rows.map(r => ({ name: r.name, conclusion: r.state, workflowName: r.workflow })) };
      for (const readable of [true, false]) {
        const workflows = readable ? rows.filter(r => r.listed).map(r => [r.suite, r.workflow]) : null;
        const watchRows = RW.checkRows(rows.map(r => [r.sha, r.name, r.state, r.suite]), [], workflows);
        for (const requiredChecks of [[], ["test"], ["CI/test"], ["Other/test"]]) {
          const gate = M.evaluate(info, { requiredChecks });
          const watch = RW.ciAtHead(HEAD, watchRows, requiredChecks);
          if (watch.state === "green" && !gate.ci_ok) unsafe.push({ rows, readable, requiredChecks, gate, watch });
          cases++;
        }
      }
    };
    for (let a = 0; a < choices.length; a++) {
      visit([a]);
      for (let b = a; b < choices.length; b++) {
        visit([a, b]);
        for (let c = b; c < choices.length; c++) visit([a, b, c]);
      }
    }
    expect(cases).toBe(26200);
    expect(unsafe).toEqual([]);
  });

  it("conflicting suite joins stay unknown instead of choosing the last workflow", () => {
    const rows = RW.checkRows([[HEAD, "test", "SUCCESS", 11]], [], [[11, "Other"], [11, "CI"], [11, "CI"]]);
    expect(rows[0].workflow).toBeNull();
    expect(RW.ciAtHead(HEAD, rows, ["CI/test"]).state).toBe("not-passed");
  });

  it("status contexts retain bare-name semantics including literal workflow/name", () => {
    const rows = RW.checkRows([], [[HEAD, "CI/test", "success"]], []);
    expect(rows[0].workflow).toBe("");
    expect(ciVerdict(HEAD, rows, ["CI/test"]).ok).toBe(true);
    expect(M.evaluate({ ...prData(scenarios[0]), statusCheckRollup: [{ context: "CI/test", state: "SUCCESS" }] }, { requiredChecks: ["CI/test"] }).ci_ok).toBe(true);
  });

  it.each(["SKIPPED", "NEUTRAL"])("all %s is not green even without requirements", (state) => {
    const rows = [{ sha: HEAD, name: "test", state }];
    expect(RW.ciAtHead(HEAD, rows).state).toBe("not-passed");
    expect(M.evaluate({ ...prData(scenarios[0]), statusCheckRollup: [{ name: "test", conclusion: state }] }).ci_ok).toBe(false);
  });

  it("SUCCESS with not-applicable checks and no requirements keeps the old output", () => {
    const info = { ...prData(scenarios[0]), statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }, { name: "docs", conclusion: "SKIPPED" }] };
    const gate = M.evaluate(info);
    expect(gate.ci_ok).toBe(true);
    expect(gate).not.toHaveProperty("required_checks");
    expect(gate).not.toHaveProperty("ci_reason");
    expect(M.render("7", gate)).toBe(`#7 head=111111111 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n=> PASS`);
  });

  it.each(["lint", false, [1], [""], ["  "], {}])("rejects malformed required list %j", (value) => {
    expect(() => requiredCheckNames(value)).toThrow(RangeError);
    expect(() => M.evaluate(prData(scenarios[0]), { requiredChecks: value as any })).toThrow(RangeError);
  });

  it("no requirements and duplicate requirements normalize consistently", () => {
    expect(requiredCheckNames(null)).toEqual([]);
    expect(requiredCheckNames(undefined)).toEqual([]);
    expect(requiredCheckNames(["CI/test", "CI/test"])).toEqual(["CI/test"]);
  });
});
