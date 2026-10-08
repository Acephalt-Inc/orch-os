// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Pack the distributable, then use its CLI and real gh adapter against deterministic API fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";
import { HEAD, prData, scenarios, type Scenario } from "./fixtures/required-checks.js";

let base: string, cli: string, home: string, data: string, log: string;
const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  cwd: ROOT, encoding: "utf8", timeout: 15_000,
  env: { ...process.env, ORCH_HOME: home, PATH: `${join(base, "bin")}:${process.env.PATH}`, OS2_FIXTURE: data, OS2_GH_LOG: log },
});
function config(required: unknown = ["CI/test"], requireCi = true) {
  const value = JSON.stringify(required);
  writeFileSync(join(home, "config.toml"), `[merge]\nrepo = "acme/widgets"\nrequired_checks = ${value}\n[review.agents.reviewer]\ncmd = [${JSON.stringify(process.execPath)}, "-e", "process.exit(0)"]\n[review.watch]\nrequire_ci = ${requireCi}\n`);
}
function fixture(s: Scenario) {
  const info = prData(s);
  writeFileSync(data, JSON.stringify({
    pr: info,
    check_runs: s.runs.map((r) => ({ head_sha: r.sha, name: r.name, conclusion: r.state || null, status: r.state || null, check_suite: { id: r.suite }, workflow: "" })),
    statuses: [],
    workflow_runs: s.workflows?.map(([suite, name]) => ({ check_suite_id: suite, name })) ?? null,
  }));
  writeFileSync(join(home, "pr.json"), JSON.stringify(info));
}

beforeAll(() => {
  base = mkdtempSync(join(ROOT, ".os2-packed-"));
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", base, "--cache", join(base, "cache")], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  expect(packed.status, packed.stderr).toBe(0);
  const filename = JSON.parse(packed.stdout)[0].filename;
  const extracted = spawnSync("tar", ["-xzf", join(base, filename), "-C", base], { encoding: "utf8" });
  expect(extracted.status, extracted.stderr).toBe(0);
  cli = join(base, "package", "dist", "cli.js");
  mkdirSync(join(base, "bin"));
  // This gh double returns the requested jq projection of raw REST shapes, not injected hosts.
  writeFileSync(join(base, "bin", "gh"), `#!${process.execPath}\n` + String.raw`
import * as fs from "node:fs";
const a = process.argv.slice(2), f = JSON.parse(fs.readFileSync(process.env.OS2_FIXTURE, "utf8"));
fs.appendFileSync(process.env.OS2_GH_LOG, JSON.stringify(a) + "\n");
const lines = rows => process.stdout.write(rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : ""));
if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify(f.pr));
else if (a[0] === "api" && a.some(x => x.endsWith("/check-runs"))) {
  if (!a.includes("--paginate") || !a[a.indexOf("--jq") + 1].includes(".check_suite.id")) process.exit(9);
  lines(f.check_runs.map(r => [r.head_sha, r.name, r.conclusion ?? r.status, r.check_suite.id]));
} else if (a[0] === "api" && a.some(x => x.endsWith("/status"))) lines(f.statuses.map(r => [f.pr.headRefOid, r.context, r.state]));
else if (a[0] === "api" && a.some(x => x.includes("/actions/runs?head_sha="))) {
  if (!a.includes("--paginate") || !a.some(x => x.endsWith("&per_page=100"))) process.exit(9);
  if (f.workflow_runs === null) { console.log(JSON.stringify([11, "CI"])); console.error("HTTP 403: workflow list unreadable"); process.exit(1); }
  lines(f.workflow_runs.map(r => [r.check_suite_id, r.name]));
} else { console.error("unexpected gh call " + JSON.stringify(a)); process.exit(9); }
`, { mode: 0o755 });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  home = mkdtempSync(join(base, "home-")); data = join(home, "api.json"); log = join(home, "gh.log");
  config();
  const claimed = invoke("task", "claim", "os2", "--as", "author");
  expect(claimed.status, claimed.stderr).toBe(0);
});

describe("RequiredChecksPackedBinary", () => {
  it.each(scenarios)("$title: packed merge-gate and review watch", (s) => {
    config(s.required ?? ["CI/test"], false);
    fixture(s);
    for (const source of ["github", "comments"]) {
      const gate = invoke("merge-gate", "7", "--fixture", join(home, "pr.json"), "--reviews", source, "--task", "os2");
      expect(gate.status, gate.stderr).toBe(s.gateGreen ? 0 : 1);
      expect(gate.stdout).toContain(s.gateGreen ? "ci=green" : "ci=NOT green");
      expect(gate.stdout).toContain(s.gateGreen ? "=> PASS" : "=> BLOCKED");
      if (s.gateReason) expect(gate.stdout).toContain(s.gateReason);
    }
    const args = ["review", "watch", "7", "--task", "os2", "--force"];
    // Blocked cases exercise the real dispatch path; controls preview without launching a worker.
    const watch = invoke(...args, ...(s.watchGreen ? ["--dry-run"] : ["--once"]));
    expect(watch.status, watch.stdout + watch.stderr).toBe(0); // WAITING under --once is explicitly exit 0.
    expect(watch.stdout).toContain(s.watchGreen ? "ci=green => DISPATCHED" : "=> WAITING");
    if (s.watchReason) expect(watch.stdout).toContain(s.watchReason);
    expect(existsSync(join(home, "review-watch"))).toBe(false);
    expect(existsSync(join(home, "workers"))).toBe(false);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls.some(a => a.some((x: string) => x.includes(`/actions/runs?head_sha=${HEAD}`)))).toBe(true);
    if (!s.watchGreen) {
      const timedOut = invoke(...args, "--timeout", "0");
      expect(timedOut.status, timedOut.stderr).toBe(1);
      expect(timedOut.stdout).toContain("=> WAITING");
      expect(existsSync(join(home, "review-watch"))).toBe(false);
      expect(existsSync(join(home, "workers"))).toBe(false);
    }
  });

  it("live merge gate and watch both block the incomplete workflow-run list", () => {
    fixture(scenarios[0]);
    const gate = invoke("merge-gate", "7", "--json");
    expect(gate.status, gate.stderr).toBe(1);
    expect(JSON.parse(gate.stdout).unmet_checks).toEqual({ "CI/test": "SKIPPED" });
    const watch = invoke("review", "watch", "7", "--task", "os2", "--once", "--json");
    expect(watch.status, watch.stdout + watch.stderr).toBe(0);
    expect(JSON.parse(watch.stdout)).toMatchObject({ outcome: "WAITING", ci: "not-passed" });
    expect(JSON.parse(watch.stdout).detail).toContain("WORKFLOW_UNKNOWN");
    expect(existsSync(join(home, "workers"))).toBe(false);
  });

  it("250 workflow runs join through the paginated API contract", () => {
    const s = { ...scenarios[4], workflows: Array.from({ length: 250 }, (_, i): [number, string] => [i, i === 11 || i === 12 ? "CI" : `other-${i}`]) };
    fixture(s);
    const result = invoke("review", "watch", "7", "--task", "os2", "--dry-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("ci=green => DISPATCHED");
  });

  it("require-check adds to config and never drops a configured missing requirement", () => {
    config(["missing"]); fixture(scenarios[4]);
    const result = invoke("merge-gate", "7", "--fixture", join(home, "pr.json"), "--require-check", "CI/test", "--require-check", "CI/test", "--json");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ required_checks: ["missing", "CI/test"], unmet_checks: { missing: "ABSENT" } });
  });

  it.each(["\"lint\"", "false", "[1]", "{}", "[\"\"]", "[\"  \"]"])("malformed config %s exits 2 in both commands", (value) => {
    fixture(scenarios[4]);
    writeFileSync(join(home, "config.toml"), `[merge]\nrequired_checks = ${value}\n`);
    for (const args of [["merge-gate", "7", "--fixture", join(home, "pr.json")], ["review", "watch", "7", "--task", "os2", "--once"]]) {
      const result = invoke(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("required_checks");
      expect(existsSync(log)).toBe(false);
    }
  });

  it("blank require-check exits 2", () => {
    fixture(scenarios[4]);
    const result = invoke("merge-gate", "7", "--fixture", join(home, "pr.json"), "--require-check", "");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("non-empty check names");
  });
});
