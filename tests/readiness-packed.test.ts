// Run the package's bin entry with a clean home and controlled, no-spend executables.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultProbes, mergeRepoProblem, timeLimitProblem } from "../src/readiness.js";
import { pidAlive, which } from "../src/util.js";
import { ROOT, waitFor } from "./_helpers.js";

const timeoutTool = which("timeout") ?? which("gtimeout");
const gitTool = which("git")!;
let root: string, bin: string, home: string, repo: string, tools: string, log: string;
let worker: unknown, reviewer: unknown, merge: unknown, minutes: unknown;
let state: any;
function fake(name: string, body = 'exit 0'): void {
  const p = join(tools, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$PROBE_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}
function configure(): void {
  writeFileSync(join(home, "config.toml"), `[workers]\ncommand = ${JSON.stringify(worker)}\ntimeout_minutes = ${JSON.stringify(minutes)}\nnice = 0\n[merge]\nrepo = ${JSON.stringify(merge)}\n[load]\nstate = ${JSON.stringify(join(home, "load.json"))}\nbusy = { load_ratio = 0.75 }\nhigh = { load_ratio = 1.0, swap_pct = 90.0 }\ncritical = { load_ratio = 1.5 }\n[review.agents.r1]\ncmd = ${JSON.stringify(reviewer)}\n`);
  writeFileSync(join(home, "load.json"), JSON.stringify(state));
}
function run(...args: string[]) {
  configure();
  return spawnSync(bin, args, { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, ORCH_AGENT_DIRS: "", PROBE_LOG: log }, encoding: "utf8", timeout: 30_000 });
}
function refuses(check: string, extra: string[] = []): void {
  const d = run("doctor", "--ready", ...extra);
  expect(d.status, d.stdout + d.stderr).toBe(1);
  expect(d.stdout).toContain(`FAIL  ${check}`);
  const w = run("worker", "start", "blocked", ...extra);
  expect(w.status, w.stdout + w.stderr).not.toBe(0);
  expect(w.stderr).toContain(check);
  expect(existsSync(join(home, "workers", "blocked"))).toBe(false);
}

beforeAll(() => {
  root = mkdtempSync(join(ROOT, ".os4-packed-"));
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: ROOT, env: { ...process.env, npm_config_cache: join(root, "npm-cache") }, encoding: "utf8", timeout: 60_000 });
  expect(packed.status, packed.stderr).toBe(0);
  const filename = JSON.parse(packed.stdout)[0].filename;
  expect(spawnSync("tar", ["-xzf", join(root, filename), "-C", root]).status).toBe(0);
  bin = join(root, "package", "dist", "cli.js");
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  const testRoot = mkdtempSync(join(root, "case-"));
  home = join(testRoot, "home"); repo = join(testRoot, "repo"); tools = join(testRoot, "tools"); log = join(testRoot, "probes.log");
  for (const p of [home, repo, tools]) mkdirSync(p);
  symlinkSync(process.execPath, join(tools, "node"));
  symlinkSync(gitTool, join(tools, "git"));
  symlinkSync("/usr/bin/env", join(tools, "env"));
  // Real timeout ensures the passing admission path also exercises an enforced time limit.
  expect(timeoutTool, "timeout or gtimeout is a test prerequisite").toBeTruthy();
  symlinkSync(timeoutTool!, join(tools, "timeout"));
  expect(spawnSync(gitTool, ["init", "-q", repo]).status).toBe(0);
  expect(spawnSync(gitTool, ["-C", repo, "remote", "add", "origin", "https://github.com/example/trial.git"]).status).toBe(0);
  fake("worker-tool"); fake("reviewer-tool"); fake("gh");
  worker = ["worker-tool"]; reviewer = ["reviewer-tool"]; merge = "example/trial"; minutes = 1;
  state = { tier: "NORMAL", ts: Date.now() / 1000, load_ratio: 0, swap_pct: 0 };
});

describe("PackedReadiness", () => {
  it("reports OK and launches using the enforced timeout", () => {
    const d = run("doctor", "--ready");
    expect(d.status, d.stdout + d.stderr).toBe(0);
    for (const name of ["worker command", "worker auth", "reviewer command", "reviewer auth", "git repo", "origin", "merge repo", "time limit", "timeout", "required-check load state"]) expect(d.stdout).toContain(`OK  ${name}`);
    const w = run("worker", "start", "good");
    expect(w.status, w.stdout + w.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(home, "workers/good/worker.json"), "utf8"));
    expect(m.argv.slice(0, 2)).toEqual([join(tools, "timeout"), "60"]);
    const probes = readFileSync(log, "utf8");
    expect(probes).toContain("worker-tool\n--version\n");
    expect(probes).toContain("reviewer-tool\n--version\n");
  });
  it("positive timeout terminates the worker launched by the packed binary", async () => {
    worker = [process.execPath, "-e", "setTimeout(() => {}, 30000)"];
    minutes = 0.02; // the launcher truncates this to one enforced second
    const r = run("worker", "start", "limited");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(home, "workers/limited/worker.json"), "utf8"));
    expect(m.argv.slice(0, 2)).toEqual([join(tools, "timeout"), "1"]);
    expect(await waitFor(() => !pidAlive(m.pid), 40, 100)).toBe(true);
  });
  it("missing worker tool", () => { rmSync(join(tools, "worker-tool")); refuses("worker command"); });
  it("missing reviewer tool", () => { rmSync(join(tools, "reviewer-tool")); refuses("reviewer command"); });
  it.each([false, 0, "", "   ", "not-a-repo", "my.org/re_po.js", "-owner/name", "owner/-name", "x".repeat(45) + "/" + "n".repeat(120), "owner/name.git", "./..", "../..", "./.", ".git/.git", "https://github.com/owner/name", "git@github.com:owner/name.git", "github.com/owner/name", "owner/name/", "owner//name", "own er/name", "owner/name#", "所有者/name", [], {}])("rejects review repo input %j", (value) => { merge = value; refuses("merge repo"); });
  it.each([0, -1, 0.001, "soon", "Infinity"])("rejects timeout %j", (value) => { minutes = value; refuses("time limit"); });
  it("checks a timeout override", () => refuses("time limit", ["--minutes", "0"]));
  it("missing timeout tool", () => { rmSync(join(tools, "timeout")); refuses("timeout"); });
  it("unusable timeout tool", () => { rmSync(join(tools, "timeout")); fake("timeout", "exit 1"); refuses("timeout"); });
  it("stale required-check load state", () => { state.ts -= 121; refuses("required-check load state"); });
  it.each([{}, { tier: "NOPE", ts: 1 }, { tier: "NORMAL", ts: Date.now() / 1000 + 3600, load_ratio: 0, swap_pct: 0 }, { tier: "NORMAL", ts: Date.now() / 1000, load_ratio: 0 }, { tier: "HIGH", ts: Date.now() / 1000, load_ratio: 1, swap_pct: 0 }])("invalid required-check load state %j", (value) => { state = value; refuses("required-check load state"); });
  it("missing load state", () => {
    configure(); rmSync(join(home, "load.json"));
    const r = spawnSync(bin, ["worker", "start", "blocked"], { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8" });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain("required-check load state");
  });
  it("corrupt load state", () => {
    configure(); writeFileSync(join(home, "load.json"), "{");
    const r = spawnSync(bin, ["doctor", "--ready"], { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8" });
    expect(r.status).toBe(1); expect(r.stdout).toContain("FAIL  required-check load state");
  });
  it("missing origin", () => { spawnSync(gitTool, ["-C", repo, "remote", "remove", "origin"]); refuses("origin"); });
  it("invalid git workdir", () => { rmSync(join(repo, ".git"), { recursive: true }); refuses("git repo"); });
  it("env wrapper checks the actual claude auth", () => { fake("claude", 'exit 1'); worker = ["env", "TOKEN=test", "claude", "-p"]; refuses("worker auth"); expect(readFileSync(log, "utf8")).toContain("claude\nauth\nstatus\n"); });
  it("a later claude argument never substitutes for gemini", () => { fake("gemini", "exit 1"); fake("claude"); worker = ["gemini", "--persona", "claude"]; refuses("worker auth"); expect(readFileSync(log, "utf8")).not.toContain("claude\n"); });
  it.each([["ssh", "box", "claude", "-p"], ["sh", "-c", "claude -p"]])("unverifiable wrapper %j", (...argv) => { fake(argv[0]); fake("claude"); worker = argv; refuses("worker auth"); });
  it("constructor executable is checked without a prototype lookup crash", () => { fake("constructor", "exit 1"); worker = ["constructor"]; refuses("worker auth"); });
  it("string worker command fails with an accurate message", () => { worker = "claude -p"; const d = run("doctor", "--ready"); expect(d.status).toBe(1); expect(d.stdout).toContain("argv array"); });
  it("reviewer auth uses codex login status", () => { fake("codex", "exit 1"); reviewer = ["codex", "exec", "-"]; refuses("reviewer auth"); expect(readFileSync(log, "utf8")).toContain("codex\nlogin\nstatus\n"); });
  it("unknown qwen uses its own version probe", () => { fake("qwen"); worker = ["qwen"]; expect(run("doctor", "--ready").status).toBe(0); expect(readFileSync(log, "utf8")).toContain("qwen\n--version\n"); });
  it("agent override checks the selected command, not the workers default", () => {
    configure(); writeFileSync(join(home, "config.toml"), readFileSync(join(home, "config.toml"), "utf8") + '\n[agents.bad]\ncommand = ["absent-agent"]\n');
    for (const args of [["doctor", "--ready", "--agent", "bad"], ["worker", "start", "blocked", "--agent", "bad"]]) {
      const r = spawnSync(bin, args, { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8" });
      expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("worker command"); expect(r.stdout + r.stderr).toContain("absent-agent");
    }
  });
  it("explicit command checks the selected executable", () => { const r = run("worker", "start", "blocked", "--", "absent-command"); expect(r.status).not.toBe(0); expect(r.stderr).toContain("worker command"); });
  it("relative worker executable resolves in its actual workdir", () => {
    writeFileSync(join(repo, "local-worker"), "#!/bin/sh\nexit 0\n"); chmodSync(join(repo, "local-worker"), 0o755);
    worker = ["./local-worker"];
    expect(run("doctor", "--ready").status).toBe(0);
    const r = run("worker", "start", "relative", "--workdir", repo);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "workers/relative/worker.json"), "utf8")).argv[2]).toBe(join(repo, "local-worker"));
  });
  it("explicit reviewer checks the selected executable", () => {
    configure(); writeFileSync(join(home, "config.toml"), readFileSync(join(home, "config.toml"), "utf8") + '\n[review.agents.bad]\ncmd = ["absent-reviewer"]\n');
    for (const args of [["doctor", "--ready", "--reviewer", "bad"], ["worker", "start", "blocked", "--reviewer", "bad"]]) {
      const r = spawnSync(bin, args, { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8" });
      expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("reviewer command");
    }
  });
  it("force cannot bypass admission with piped stdin", () => { const r = run("worker", "start", "blocked", "--force"); expect(r.status).not.toBe(0); expect(r.stderr).toContain("attended use only"); expect(existsSync(join(home, "workers/blocked"))).toBe(false); });
  it("packed CLI warns for force with simulated terminal stdin", () => {
    configure();
    const program = `Object.defineProperty(process.stdin, "isTTY", { value: true }); const { main } = await import(${JSON.stringify(bin)}); process.exitCode = await main(["worker", "start", "attended", "--force", "--minutes", "0"]);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8", timeout: 10_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("WARNING: attended --force");
    expect(existsSync(join(home, "workers/attended/PID"))).toBe(true);
  });
  it("plain doctor retains fixture-friendly behavior", () => { const r = run("doctor"); expect(r.stdout).not.toContain("ready-for-live"); expect(existsSync(log)).toBe(false); });
});

describe("F4ProbeAndRules", () => {
  it("Infinity and sub-second limits fail", () => { for (const n of [Infinity, -Infinity, NaN, 0.001]) expect(timeLimitProblem(n)).not.toBeNull(); });
  it.each(["OWNER/Name", "owner/re_po.js", "owner/.hidden", "owner/repo-name"])("usable repo %s", (v) => expect(mergeRepoProblem(v)).toBeNull());
  it("the real probe returns null for timeout, signal and spawn failure", () => {
    expect(defaultProbes.exitCode(process.execPath, ["-e", "setTimeout(() => {}, 30000)"])).toBeNull();
    expect(defaultProbes.exitCode(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"])).toBeNull();
    expect(defaultProbes.exitCode("/absent-orch-tool", [])).toBeNull();
  });
  it("Node minimum agrees in manifest, installer and both READMEs", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=22");
    const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(installer).toContain('>= 22 ? 0 : 1');
    expect(installer).toContain('need Node.js >= 22');
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("Node.js 22 or newer");
    expect(readFileSync(join(ROOT, "README.zh.md"), "utf8")).toContain("Node.js 22 或更高版本");
  });
});
