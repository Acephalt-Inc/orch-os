// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Pack the distributable, then use its CLI and real gh adapter against deterministic API fixtures.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";
import { HEAD, prData, scenarios, type Scenario } from "./fixtures/required-checks.js";

let base: string, cli: string, home: string, data: string, log: string;
let registryLog: string, npmConfig: Record<string, any>, packArgs: string[];

// Build from a scrubbed environment: npm must not load developer config or auth tokens.
function packEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^npm_config_/i.test(key) && !/^(NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key)));
  return { ...env, HOME: join(base, "npm-home") };
}

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

beforeAll(async () => {
  base = mkdtempSync(join(ROOT, ".os2-packed-"));
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
    const registry = `http://127.0.0.1:${port}`;
    const userconfig = join(base, "empty-user.npmrc"), globalconfig = join(base, "empty-global.npmrc");
    writeFileSync(userconfig, ""); writeFileSync(globalconfig, "");
    mkdirSync(join(base, "npm-home"));
    const developerConfig = join(base, "developer-user.npmrc"), developerGlobal = join(base, "developer-global.npmrc");
    writeFileSync(developerGlobal, `registry=${registry}\n`);
    writeFileSync(developerConfig, `registry=${registry}\n//127.0.0.1:${port}/:_authToken=fixture-credential\n`);
    const poison = { npm_config_registry: registry, npm_config_userconfig: developerConfig,
      npm_config_globalconfig: developerGlobal, NPM_TOKEN: "fixture-credential", NODE_AUTH_TOKEN: "fixture-credential" };
    const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    let packed: ReturnType<typeof spawnSync>;
    try {
      Object.assign(process.env, poison);
      // Isolated cwd also prevents loading the checkout's project .npmrc.
      packArgs = ["pack", ROOT, "--json", "--pack-destination", base, "--cache", join(base, "cache"),
        "--offline", "--update-notifier=false", "--userconfig", userconfig, "--globalconfig", globalconfig,
        "--registry", registry];
      const env = packEnvironment();
      // Read npm's resolved config under the SAME argv policy used by npm pack.
      const resolved = spawnSync("npm", ["config", "list", "--json", ...packArgs.slice(7)],
        { cwd: base, env, encoding: "utf8", timeout: 15_000 });
      expect(resolved.status, resolved.stderr).toBe(0);
      npmConfig = JSON.parse(resolved.stdout);
      packed = spawnSync("npm", packArgs, { cwd: base, env, encoding: "utf8", timeout: 60_000 });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(packed.status, packed.stderr).toBe(0);
    const filename = JSON.parse(String(packed.stdout))[0].filename;
    cli = join(base, "package", "dist", "cli.js");
    const extracted = spawnSync("tar", ["-xzf", join(base, filename), "-C", base], { encoding: "utf8" });
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
  it("npm pack is offline, disables the notifier, and isolates developer credentials", () => {
    // Review v1 exact mutation: replace the guarded pack call with the original:
    // spawnSync("npm", ["pack", "--json", "--pack-destination", base, "--cache", join(base, "cache")], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    // The observer changes only registry/config, never forces the update notifier on.
    expect(readFileSync(registryLog, "utf8")).toBe("");
    expect(npmConfig.offline).toBe(true);
    expect(npmConfig["update-notifier"]).toBe(false);
    expect(npmConfig.userconfig).toBe(join(base, "empty-user.npmrc"));
    expect(npmConfig.globalconfig).toBe(join(base, "empty-global.npmrc"));
    expect(readFileSync(npmConfig.userconfig, "utf8")).toBe("");
    expect(readFileSync(npmConfig.globalconfig, "utf8")).toBe("");
    expect(packEnvironment()).not.toHaveProperty("NPM_TOKEN");
    expect(packEnvironment()).not.toHaveProperty("NODE_AUTH_TOKEN");
  });

  it("packed policy stays in mergegate without an out-of-scope checks module", () => {
    // Review v1 scope mutation: restore src/checks.ts's shared evaluator and imports.
    expect(existsSync(join(base, "package", "dist", "checks.js"))).toBe(false);
    expect(readFileSync(join(base, "package", "dist", "mergegate.js"), "utf8")).toContain("export function ciVerdict(");
    expect(readFileSync(join(base, "package", "dist", "reviewwatch.js"), "utf8")).not.toContain('./checks.js');
  });

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
