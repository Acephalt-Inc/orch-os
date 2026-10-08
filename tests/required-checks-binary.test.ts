// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Pack the distributable from a disposable source copy, then use its CLI and real gh adapter
// against deterministic API fixtures. The developer checkout is never built, cleaned or packed here.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { which } from "../src/util.js";
import { ROOT } from "./_helpers.js";
import { candidate, pack, plantRetired } from "./_pack.js";
import { HEAD, prData, scenarios, type Scenario } from "./fixtures/required-checks.js";

let base: string, cli: string, home: string, data: string, log: string, workdir: string;
let registryLog: string, observerRegistry: string, npmConfig: Record<string, any>, copy: ReturnType<typeof candidate>;
const packDirs: string[] = [];

// The environment npm actually ran with: the shared helper scrubbed it while the developer
// config and tokens below were set in process.env.
const packEnvironment = (): NodeJS.ProcessEnv => copy.env;

const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  cwd: workdir, encoding: "utf8", timeout: 15_000,
  env: { ...process.env, ORCH_HOME: home, PATH: join(base, "bin"), FAKE_GH_FIXTURE: data, FAKE_GH_LOG: log },
});
function config(required: unknown = ["CI/test"], requireCi = true) {
  const value = JSON.stringify(required);
  writeFileSync(join(home, "config.toml"), `[merge]\nrepo = "acme/widgets"\nrequired_checks = ${value}\n[review.agents.reviewer]\ncmd = ["codex", "exec", "-"]\n[review.watch]\nrequire_ci = ${requireCi}\n`);
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

beforeAll(async () => {
  base = mkdtempSync(join(ROOT, ".packed-cli-"));
  registryLog = join(base, "registry.log");
  writeFileSync(registryLog, "");
  // A separate observer process keeps serving while synchronous npm packing runs.
  const observer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:http";
    import { appendFileSync } from "node:fs";
    const server = createServer((req, res) => {
      appendFileSync(process.argv[1], req.method + " " + req.url + "\\n");
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `, registryLog], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      observer.stdout.once("data", chunk => resolve(String(chunk).trim()));
      observer.once("error", reject);
      observer.once("exit", code => reject(new Error(`registry observer exited ${code}`)));
    });
    const registry = observerRegistry = `http://127.0.0.1:${port}`;
    const developerConfig = join(base, "developer-user.npmrc"), developerGlobal = join(base, "developer-global.npmrc");
    writeFileSync(developerGlobal, `registry=${registry}\n`);
    writeFileSync(developerConfig, `registry=${registry}\n//127.0.0.1:${port}/:_authToken=fixture-credential\n`);
    const poison = { npm_config_registry: registry, npm_config_userconfig: developerConfig,
      npm_config_globalconfig: developerGlobal, NPM_TOKEN: "fixture-credential", NODE_AUTH_TOKEN: "fixture-credential" };
    const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    let tarball: string;
    try {
      Object.assign(process.env, poison);
      // The copy holds src, package metadata, tsconfig and packaged assets: no .git, no project
      // .npmrc, no checkout dist. prepack deletes dist, so it must never run in ROOT.
      copy = candidate(packDirs);
      // Residue of a previous build in the copy: the packed artifact must not carry it.
      plantRetired(copy.repo);
      // Distinct empty config files inside the copy, named on argv as well as in its environment.
      const guard = ["--update-notifier=false", "--userconfig", copy.userconfig, "--globalconfig", copy.globalconfig, "--registry", registry];
      // Read npm's resolved config under the SAME argv policy used by npm pack.
      npmConfig = JSON.parse(copy.run("npm", ["config", "list", "--json", "--offline", ...guard]));
      tarball = pack(copy, guard);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    cli = join(base, "package", "dist", "cli.js");
    const extracted = spawnSync("tar", ["-xzf", tarball, "-C", base], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
  } finally {
    if (observer.exitCode === null && observer.signalCode === null) {
      const stopped = new Promise<void>(resolve => observer.once("exit", () => resolve()));
      observer.kill();
      await stopped;
    }
  }
  mkdirSync(join(base, "bin"));
  // This gh double returns the requested jq projection of raw REST shapes, not injected hosts.
  writeFileSync(join(base, "bin", "gh"), `#!${process.execPath}\n` + String.raw`
import * as fs from "node:fs";
const a = process.argv.slice(2), f = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + "\n");
const lines = rows => process.stdout.write(rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : ""));
const jq = a.includes("--jq") ? a[a.indexOf("--jq") + 1] : "";
if (a[0] === "auth" && a[1] === "status") process.exit(0);
else if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify(f.pr));
else if (a[0] === "api" && a.some(x => x.endsWith("/check-runs"))) {
  if (!a.includes("--paginate") || !a[a.indexOf("--jq") + 1].includes(".check_suite.id")) process.exit(9);
  lines(f.check_runs.map(r => [r.head_sha, r.name, r.conclusion ?? r.status, r.check_suite.id]));
} else if (a[0] === "api" && a.some(x => x.endsWith("/status"))) {
  // The projection below is only valid for this exact expression.
  if (!a.includes("--paginate") || jq !== ".sha as $s | .statuses[] | [$s, .context, .state] | @json") process.exit(9);
  lines(f.statuses.map(r => [f.pr.headRefOid, r.context, r.state]));
} else if (a[0] === "api" && a.some(x => x.includes("/actions/runs?head_sha="))) {
  if (!a.includes("--paginate") || !a.some(x => x.endsWith("&per_page=100"))) process.exit(9);
  if (jq !== ".workflow_runs[] | [.check_suite_id, .name] | @json") process.exit(9);
  if (f.workflow_runs === null) { console.log(JSON.stringify([11, "CI"])); console.error("HTTP 403: workflow list unreadable"); process.exit(1); }
  lines(f.workflow_runs.map(r => [r.check_suite_id, r.name]));
} else { console.error("unexpected gh call " + JSON.stringify(a)); process.exit(9); }
`, { mode: 0o755 });
  // A reviewer the launch admission can verify: its login-status command exits 0. It is never started here.
  writeFileSync(join(base, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The CLI runs with this directory as its whole PATH and in its own git repository with an
  // origin, so a previewed dispatch does not depend on the developer's PATH or checkout.
  const git = which("git"), limiter = which("timeout") ?? which("gtimeout");
  expect(git, "git is a test prerequisite").toBeTruthy();
  expect(limiter, "timeout or gtimeout is a test prerequisite").toBeTruthy();
  symlinkSync(git!, join(base, "bin", "git"));
  symlinkSync(limiter!, join(base, "bin", "timeout"));
  workdir = join(base, "repo");
  expect(spawnSync(git!, ["init", "-q", workdir]).status).toBe(0);
  expect(spawnSync(git!, ["-C", workdir, "remote", "add", "origin", "https://github.com/acme/widgets.git"]).status).toBe(0);
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  for (const dir of packDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  home = mkdtempSync(join(base, "home-")); data = join(home, "api.json"); log = join(home, "gh.log");
  config();
  // Fresh load state: a previewed dispatch runs the same admission as a real one.
  writeFileSync(join(home, "load.json"), JSON.stringify({ tier: "NORMAL", ts: Date.now() / 1000, load_ratio: 0, swap_pct: 0 }));
  const claimed = invoke("task", "claim", "gating", "--as", "author");
  expect(claimed.status, claimed.stderr).toBe(0);
});

describe("RequiredChecksPackedBinary", () => {
  it("npm pack is offline, disables the notifier, and isolates developer credentials", () => {
    // Mutation witness: replace the guarded pack call with an unguarded one:
    // spawnSync("npm", ["pack", "--json", "--pack-destination", base, "--cache", join(base, "cache")], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    // (now `tarball = pack(copy, guard)`; run that mutation only in a disposable checkout: it builds in ROOT).
    // The observer changes only registry/config, never forces the update notifier on.
    expect(readFileSync(registryLog, "utf8")).toBe("");
    expect(npmConfig.offline).toBe(true);
    expect(npmConfig["update-notifier"]).toBe(false);
    expect(npmConfig.userconfig).toBe(copy.userconfig);
    expect(npmConfig.globalconfig).toBe(copy.globalconfig);
    expect(npmConfig.userconfig).not.toBe(npmConfig.globalconfig);
    for (const developer of ["developer-user.npmrc", "developer-global.npmrc"]) {
      expect([npmConfig.userconfig, npmConfig.globalconfig]).not.toContain(join(base, developer));
    }
    expect(npmConfig.registry.replace(/\/$/, "")).toBe(observerRegistry);
    expect(readFileSync(npmConfig.userconfig, "utf8")).toBe("");
    expect(readFileSync(npmConfig.globalconfig, "utf8")).toBe("");
    expect(packEnvironment()).not.toHaveProperty("NPM_TOKEN");
    expect(packEnvironment()).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(Object.keys(packEnvironment()).filter(key => /^npm_config_(registry|userconfig|globalconfig)$/.test(key))).toEqual([]);
    // HOME, cache and the build itself live in the disposable copy, outside the checkout.
    expect(packEnvironment().HOME).toBe(copy.home);
    expect(npmConfig.cache).toBe(join(copy.dir, "cache"));
    expect(copy.dir.startsWith(ROOT)).toBe(false);
    expect(existsSync(join(copy.repo, ".git"))).toBe(false);
    expect(existsSync(join(copy.repo, ".npmrc"))).toBe(false);
  });

  it("packed policy stays in mergegate without an out-of-scope checks module", () => {
    // Mutation witness: move the shared evaluator into a src/checks.ts module.
    // The copy was seeded with dist/checks.js and dist/retired.js before packing.
    expect(existsSync(join(base, "package", "dist", "checks.js"))).toBe(false);
    expect(existsSync(join(base, "package", "dist", "retired.js"))).toBe(false);
    expect(readFileSync(join(base, "package", "dist", "mergegate.js"), "utf8")).toContain("export function ciVerdict(");
    expect(readFileSync(join(base, "package", "dist", "reviewwatch.js"), "utf8")).not.toContain('./checks.js');
  });

  it.each(scenarios)("$title: packed merge-gate and review watch", (s) => {
    config(s.required ?? ["CI/test"], false);
    fixture(s);
    for (const source of ["github", "comments"]) {
      const gate = invoke("merge-gate", "7", "--fixture", join(home, "pr.json"), "--reviews", source, "--task", "gating");
      expect(gate.status, gate.stderr).toBe(s.gateGreen ? 0 : 1);
      expect(gate.stdout).toContain(s.gateGreen ? "ci=green" : "ci=NOT green");
      expect(gate.stdout).toContain(s.gateGreen ? "=> PASS" : "=> BLOCKED");
      if (s.gateReason) expect(gate.stdout).toContain(s.gateReason);
    }
    const args = ["review", "watch", "7", "--task", "gating", "--force"];
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
    const watch = invoke("review", "watch", "7", "--task", "gating", "--once", "--json");
    expect(watch.status, watch.stdout + watch.stderr).toBe(0);
    expect(JSON.parse(watch.stdout)).toMatchObject({ outcome: "WAITING", ci: "not-passed" });
    expect(JSON.parse(watch.stdout).detail).toContain("WORKFLOW_UNKNOWN");
    expect(existsSync(join(home, "workers"))).toBe(false);
  });

  it("250 workflow runs join through the paginated API contract", () => {
    const s = { ...scenarios[4], workflows: Array.from({ length: 250 }, (_, i): [number, string] => [i, i === 11 || i === 12 ? "CI" : `other-${i}`]) };
    fixture(s);
    const result = invoke("review", "watch", "7", "--task", "gating", "--dry-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("ci=green => DISPATCHED");
  });

  it("required suite appears only after workflow row 200", () => {
    // Adapter contract against the fake gh (not live GitHub pagination): the two suites that can
    // supply CI/test are rows 211 and 241 of the workflow-run list.
    const all = Array.from({ length: 250 }, (_, i): [number, string] => i === 210 ? [11, "CI"] : i === 240 ? [12, "CI"] : [1000 + i, `other-${i}`]);
    fixture({ ...scenarios[4], workflows: all });
    const joined = invoke("review", "watch", "7", "--task", "gating", "--dry-run");
    expect(joined.status, joined.stdout + joined.stderr).toBe(0);
    expect(joined.stdout).toContain("ci=green => DISPATCHED");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls).toContainEqual(["api", "--paginate", `repos/acme/widgets/actions/runs?head_sha=${HEAD}&per_page=100`,
      "--jq", ".workflow_runs[] | [.check_suite_id, .name] | @json"]);
    expect(calls).toContainEqual(["api", "--paginate", `repos/acme/widgets/commits/${HEAD}/status`,
      "--jq", ".sha as $s | .statuses[] | [$s, .context, .state] | @json"]);
    // Control: the same list cut after row 200 leaves both suites unknown, so nothing is dispatched.
    fixture({ ...scenarios[4], workflows: all.slice(0, 200) });
    const cut = invoke("review", "watch", "7", "--task", "gating", "--once");
    expect(cut.status, cut.stdout + cut.stderr).toBe(0);
    expect(cut.stdout).toContain("=> WAITING");
    expect(cut.stdout).toContain("CI/test=WORKFLOW_UNKNOWN");
    expect(existsSync(join(home, "review-watch"))).toBe(false);
    expect(existsSync(join(home, "workers"))).toBe(false);
  });

  const job = (name: string, suite: number, workflow: string, state = "SUCCESS") => ({ sha: HEAD, name, workflow, state, suite });
  const sources = [["--reviews", "github"], ["--reviews", "comments", "--task", "gating"]];

  it("distinct repeated flags all add to config", () => {
    // Mutation witnesses: pass only a.require_check.slice(0, 1), or only .slice(-1), where src/cli.ts reads the flag.
    config(["CI/test"]);
    fixture({ title: "two passing jobs", runs: [job("test", 11, "CI"), job("lint", 12, "CI")], workflows: [[11, "CI"], [12, "CI"]], gateGreen: true, watchGreen: true });
    for (const source of sources) {
      const gate = (first: string, second: string) => {
        const result = invoke("merge-gate", "7", "--fixture", join(home, "pr.json"), ...source, "--require-check", first, "--require-check", second, "--json");
        return { status: result.status, out: JSON.parse(result.stdout) };
      };
      const both = gate("CI/lint", "test");
      expect(both.status).toBe(0);
      expect(both.out).toMatchObject({ ok: true, ci_ok: true, required_checks: ["CI/test", "CI/lint", "test"], unmet_checks: {} });
      const firstMissing = gate("Docs/build", "CI/lint");
      expect(firstMissing.status).toBe(1);
      expect(firstMissing.out.required_checks).toEqual(["CI/test", "Docs/build", "CI/lint"]);
      expect(firstMissing.out.unmet_checks).toEqual({ "Docs/build": "ABSENT" });
      const secondMissing = gate("CI/lint", "Docs/build");
      expect(secondMissing.status).toBe(1);
      expect(secondMissing.out.required_checks).toEqual(["CI/test", "CI/lint", "Docs/build"]);
      expect(secondMissing.out.unmet_checks).toEqual({ "Docs/build": "ABSENT" });
    }
  });

  it("text and JSON name every unmet requirement and explain unknown workflow", () => {
    // Mutation witnesses: report only unmet.slice(0, 1) at src/mergegate.ts:272-273; delete the
    // WORKFLOW_UNKNOWN sentence at src/reviewwatch.ts:522.
    const required = ["CI/test", "Lint/lint", "Docs/build"];
    config(required, false);
    fixture({ title: "two unmet names", runs: [job("test", 11, "CI"), job("lint", 12, "Lint", "SKIPPED")], workflows: [[11, "CI"]], required, gateGreen: false, watchGreen: false });
    for (const source of sources) {
      const args = ["merge-gate", "7", "--fixture", join(home, "pr.json"), ...source];
      const text = invoke(...args);
      expect(text.status, text.stderr).toBe(1);
      expect(text.stdout).toContain('ci=NOT green (required check not passed {"Lint/lint": "SKIPPED", "Docs/build": "ABSENT"})');
      const json = invoke(...args, "--json");
      expect(json.status, json.stderr).toBe(1);
      expect(JSON.parse(json.stdout).required_checks).toEqual(required);
      expect(JSON.parse(json.stdout).unmet_checks).toEqual({ "Lint/lint": "SKIPPED", "Docs/build": "ABSENT" });
    }
    const names = "Lint/lint=WORKFLOW_UNKNOWN, Docs/build=ABSENT";
    const sentence = "WORKFLOW_UNKNOWN means a same-name check could not be joined to a workflow";
    const text = invoke("review", "watch", "7", "--task", "gating", "--once");
    expect(text.status, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toContain("ci=not-passed => WAITING");
    expect(text.stdout).toContain(names);
    expect(text.stdout).toContain(sentence);
    const json = invoke("review", "watch", "7", "--task", "gating", "--once", "--json");
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "WAITING", ci: "not-passed" });
    expect(JSON.parse(json.stdout).detail).toContain(names);
    expect(JSON.parse(json.stdout).detail).toContain(sentence);
    expect(existsSync(join(home, "review-watch"))).toBe(false);
    expect(existsSync(join(home, "workers"))).toBe(false);
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
    for (const args of [["merge-gate", "7", "--fixture", join(home, "pr.json")], ["review", "watch", "7", "--task", "gating", "--once"]]) {
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
