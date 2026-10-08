// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ciVerdict, requiredCheckNames } from "../src/mergegate.js";
import * as M from "../src/mergegate.js";
import * as RW from "../src/reviewwatch.js";
import { ROOT } from "./_helpers.js";
import { HEAD, OLD_HEAD, caseScenarios, prData, scenarios, type Scenario } from "./fixtures/required-checks.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(ROOT, ".os2-policy-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RequiredChecksPolicy", () => {
  it("shared CI evaluator stays in the allowed mergegate module", () => {
    // Review v1 scope mutation: restore the new src/checks.ts shared evaluator
    // and its imports (src/checks.ts:30 was outside the production allowlist).
    expect(existsSync(join(ROOT, "src", "checks.ts"))).toBe(false);
    expect(readFileSync(join(ROOT, "src", "mergegate.ts"), "utf8")).toContain("export function ciVerdict(");
    expect(readFileSync(join(ROOT, "src", "reviewwatch.ts"), "utf8")).not.toContain('./checks.js');
  });


  it("CLI diff contains only required-check command plumbing", () => {
    // Review v1 exact scope regression: restore src/cli.ts:473's requiredChecks
    // helper and its src/checks.ts import, outside the allowed policy modules.
    const base = spawnSync("git", ["show", "41b86f750b1dca1368b153cc932f9b58732c5d66:src/cli.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(base.status, base.stderr).toBe(0);
    const cli = readFileSync(join(ROOT, "src", "cli.ts"), "utf8")
      .replace("  const checks = M.configuredRequiredChecks(cfg, a.require_check);\n", "")
      .replace("  const checks = M.configuredRequiredChecks(cfg);\n", "")
      .replaceAll("requiredChecks: checks, ", "")
      .replace(", requiredChecks: checks,", ",")
      .replace('          opt("require_check", ["--require-check"], "list", "required name or workflow/name; repeat to add to [merge] required_checks"),\n', "");
    expect(cli).toBe(base.stdout);
  });

  const exercise = (s: Scenario) => {
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
  };
  it.each(scenarios)("$title: gate and actual dispatch", exercise);

  it("bare and qualified job names remain case sensitive", () => {
    // Mutation witness: compare lower-cased names at src/mergegate.ts:67-68.
    expect(caseScenarios.filter(s => s.gateGreen).length).toBe(4);
    expect(caseScenarios.filter(s => !s.gateGreen).length).toBe(7);
    for (const s of caseScenarios) exercise(s);
  });

  it("explicit head_sha alias rejects stale success", () => {
    // Mutation witness: drop `?? c.head_sha` at src/mergegate.ts:265.
    const rollup = (sha: string) => [
      { name: "test", workflowName: "CI", conclusion: "SUCCESS", head_sha: sha },
      { name: "lint", workflowName: "CI", conclusion: "SUCCESS", head_sha: HEAD },
    ];
    for (const source of [{}, { reviewSource: "comments" as const, authorAgents: ["author"] }]) {
      const stale = M.evaluate({ ...prData(scenarios[0]), statusCheckRollup: rollup(OLD_HEAD) }, { requiredChecks: ["CI/test"], ...source });
      expect(stale.ci_ok).toBe(false);
      expect(stale.ok).toBe(false);
      expect(stale.unmet_checks).toEqual({ "CI/test": "ABSENT" });
      const current = M.evaluate({ ...prData(scenarios[0]), statusCheckRollup: rollup(HEAD) }, { requiredChecks: ["CI/test"], ...source });
      expect(current.ci_ok).toBe(true);
      expect(current.ok).toBe(true);
      expect(current.unmet_checks).toEqual({});
    }
  });

  it("generated two required names block one listed workflow in both requirement orders", () => {
    // Review v1 exact replacement of src/reviewwatch.ts:516:
    // const ci = ciAtHead(head, rows, (inp.requiredChecks ?? []).slice(0, rows.filter(r => r.workflow != null && r.workflow !== "").length || undefined));
    for (const state of ["SKIPPED", "NEUTRAL"]) for (const reverse of [false, true]) {
      exercise({
        title: `generated ${state}, reverse=${reverse}`, required: reverse ? ["Lint/lint", "CI/test"] : ["CI/test", "Lint/lint"],
        runs: [
          { sha: HEAD, name: "test", state: "SUCCESS", suite: 11, workflow: "CI" },
          { sha: HEAD, name: "lint", state, suite: 12, workflow: "Lint" },
        ],
        workflows: [[11, "CI"]], gateGreen: false, watchGreen: false,
        gateReason: state, watchReason: "Lint/lint=WORKFLOW_UNKNOWN",
      });
    }
  });

  it("no watch-green gate-red result across 52400 partial-list combinations with multiple requirements", () => {
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
        for (const requiredChecks of [[], ["test"], ["CI/test"], ["Other/test"], ["CI/test", "Other/test"], ["Other/test", "CI/test"], ["CI/test", "Lint/lint"], ["Lint/lint", "CI/test"]]) {
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
    expect(cases).toBe(52400);
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

  it.each(["SKIPPED", "NEUTRAL"])("SUCCESS with not-applicable checks and no requirements keeps the old output: %s", (state) => {
    const info = { ...prData(scenarios[0]), statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }, { name: "docs", conclusion: state }] };
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
