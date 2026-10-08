// Run the package's bin entry with a clean home and controlled, no-spend executables.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commandChecks, defaultProbes, mergeRepoProblem, readiness, render, timeLimitProblem } from "../src/readiness.js";
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
/** The row is UNVERIFIED (never OK, never FAIL), the verdict is NOT READY and launch is refused. */
function unverified(check: string): void {
  const d = run("doctor", "--ready");
  expect(d.status, d.stdout + d.stderr).toBe(1);
  expect(d.stdout).toContain(`UNVERIFIED  ${check}`);
  expect(d.stdout).not.toContain(`OK  ${check}`);
  expect(d.stdout).toContain("ready-for-live: NOT READY");
  expect(d.stdout).toContain(`unverified checks: ${check}`);
  const w = run("worker", "start", "blocked");
  expect(w.status, w.stdout + w.stderr).not.toBe(0);
  expect(w.stderr).toContain(`${check} (UNVERIFIED: `);
  expect(existsSync(join(home, "workers", "blocked"))).toBe(false);
}
/** Run the packed CLI without rewriting config.toml. */
function raw(args: string[], h = home) {
  return spawnSync(bin, args, { cwd: repo, env: { HOME: h, ORCH_HOME: h, GIT_CEILING_DIRECTORIES: root, PATH: tools, ORCH_AGENT_DIRS: "", PROBE_LOG: log }, encoding: "utf8", timeout: 30_000 });
}

beforeAll(() => {
  root = mkdtempSync(join(ROOT, ".readiness-packed-"));
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
  // Only claude and codex have a login-status probe, so only they can pass admission.
  fake("claude"); fake("codex"); fake("gh");
  worker = ["claude", "-p"]; reviewer = ["codex", "exec", "-"]; merge = "example/trial"; minutes = 1;
  state = { tier: "NORMAL", ts: Date.now() / 1000, load_ratio: 0, swap_pct: 0 };
});

describe("PackedReadiness", () => {
  it("reports OK and launches using the enforced timeout", () => {
    const d = run("doctor", "--ready");
    expect(d.status, d.stdout + d.stderr).toBe(0);
    for (const name of ["worker command", "worker auth", "reviewer command", "reviewer auth", "git repo", "origin", "merge repo", "time limit", "timeout", "required-check load state"]) expect(d.stdout).toContain(`OK  ${name}`);
    expect(d.stdout).toContain("OK  gh auth  gh auth status: exit 0");
    const w = run("worker", "start", "good");
    expect(w.status, w.stdout + w.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(home, "workers/good/worker.json"), "utf8"));
    expect(m.argv.slice(0, 2)).toEqual([join(tools, "timeout"), "60"]);
    const probes = readFileSync(log, "utf8");
    expect(probes).toContain("claude\nauth\nstatus\n");
    expect(probes).toContain("codex\nlogin\nstatus\n");
    expect(probes).not.toContain("--version");
  });
  it("positive timeout terminates the worker launched by the packed binary", async () => {
    fake("claude", 'if [ "$1" = auth ]; then exit 0; fi; exec /bin/sleep 30'); worker = ["claude"];
    minutes = 0.02; // the launcher truncates this to one enforced second
    const r = run("worker", "start", "limited");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(home, "workers/limited/worker.json"), "utf8"));
    expect(m.argv.slice(0, 2)).toEqual([join(tools, "timeout"), "1"]);
    expect(await waitFor(() => !pidAlive(m.pid), 40, 100)).toBe(true);
  });
  it("missing worker tool", () => { rmSync(join(tools, "claude")); refuses("worker command"); });
  it("missing reviewer tool", () => { rmSync(join(tools, "codex")); refuses("reviewer command"); });
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
  it("env wrapper is UNVERIFIED and is not parsed", () => { fake("claude", 'exit 1'); worker = ["env", "TOKEN=test", "claude", "-p"]; unverified("worker auth"); expect(readFileSync(log, "utf8")).not.toContain("claude\n"); });
  it("logged-out claude worker fails its login-status probe", () => { fake("claude", 'exit 1'); refuses("worker auth"); expect(readFileSync(log, "utf8")).toContain("claude\nauth\nstatus\n"); });
  it("a later claude argument never substitutes for gemini", () => { fake("gemini", "exit 1"); fake("claude"); worker = ["gemini", "--persona", "claude"]; unverified("worker auth"); expect(readFileSync(log, "utf8")).not.toContain("claude\n"); });
  it.each([["ssh", "box", "claude", "-p"], ["sh", "-c", "claude -p"]])("unverifiable wrapper %j", (...argv) => { fake(argv[0]); fake("claude"); worker = argv; unverified("worker auth"); });
  it("constructor executable is checked without a prototype lookup crash", () => { fake("constructor", "exit 1"); worker = ["constructor"]; unverified("worker auth"); });
  it("string worker command fails with an accurate message", () => { worker = "claude -p"; const d = run("doctor", "--ready"); expect(d.status).toBe(1); expect(d.stdout).toContain("argv array"); });
  it("reviewer auth uses codex login status", () => { fake("codex", "exit 1"); reviewer = ["codex", "exec", "-"]; refuses("reviewer auth"); expect(readFileSync(log, "utf8")).toContain("codex\nlogin\nstatus\n"); });
  it("unknown qwen is UNVERIFIED and --version is never run as login", () => { fake("qwen"); worker = ["qwen"]; unverified("worker auth"); expect(readFileSync(log, "utf8")).not.toContain("qwen\n"); });
  it("agent override checks the selected command, not the workers default", () => {
    configure(); writeFileSync(join(home, "config.toml"), readFileSync(join(home, "config.toml"), "utf8") + '\n[agents.bad]\ncommand = ["absent-agent"]\n');
    for (const args of [["doctor", "--ready", "--agent", "bad"], ["worker", "start", "blocked", "--agent", "bad"]]) {
      const r = spawnSync(bin, args, { cwd: repo, env: { HOME: home, ORCH_HOME: home, GIT_CEILING_DIRECTORIES: root, PATH: tools, PROBE_LOG: log }, encoding: "utf8" });
      expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("worker command"); expect(r.stdout + r.stderr).toContain("absent-agent");
    }
  });
  it("explicit command checks the selected executable", () => { const r = run("worker", "start", "blocked", "--", "absent-command"); expect(r.status).not.toBe(0); expect(r.stderr).toContain("worker command"); });
  it("relative worker executable resolves in its actual workdir", () => {
    writeFileSync(join(repo, "claude"), "#!/bin/sh\nexit 0\n"); chmodSync(join(repo, "claude"), 0o755);
    worker = ["./claude"];
    expect(run("doctor", "--ready").status).toBe(0);
    const r = run("worker", "start", "relative", "--workdir", repo);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "workers/relative/worker.json"), "utf8")).argv[2]).toBe(join(repo, "claude"));
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
  it.each([["nice", "claude", "-p"], ["npx", "claude", "-p"], ["python3", "agent.py"], ["sudo", "claude", "-p"], ["timeout", "60", "claude", "-p"], ["nohup", "claude", "-p"], ["env", "A=1", "nice", "claude"]])("wrapper or unknown command %j is UNVERIFIED, never OK", (...argv) => {
    fake("claude", "exit 1"); // logged out behind the wrapper
    for (const tool of ["nice", "npx", "python3", "sudo", "nohup"]) fake(tool);
    worker = argv; unverified("worker auth");
    const probes = readFileSync(log, "utf8");
    expect(probes).not.toContain("--version");
    expect(probes).not.toContain("claude\n");
  });
  it("unknown reviewer CLI is UNVERIFIED, never OK", () => { fake("reviewer-tool"); reviewer = ["reviewer-tool"]; unverified("reviewer auth"); expect(readFileSync(log, "utf8")).not.toContain("reviewer-tool\n"); });
  it("auth probe that could not run is NOT READY", () => {
    fake("claude", 'if [ "$1" = auth ]; then kill -TERM $$; fi');
    refuses("worker auth (claude auth status: could not run");
  });
  it("missing gh", () => { rmSync(join(tools, "gh")); refuses("gh (gh not on PATH)"); });
  it("logged-out gh", () => { fake("gh", "exit 1"); refuses("gh auth (gh auth status: exit 1)"); });
  it("review watch dispatches its selected reviewer through the non-force path", () => {
    const head = "a".repeat(40);
    fake("gh", `case "$1 $2" in "pr view") printf '%s\\n' '{"headRefOid":"${head}","state":"OPEN","comments":[]}';; "api --paginate") case "$3" in */check-runs) printf '%s\\n' '["${head}","ci","success"]';; esac;; esac`);
    fake("codex", "exit 1"); // r1 is listed first, holds the task (the author) and is logged out
    configure();
    writeFileSync(join(home, "config.toml"), readFileSync(join(home, "config.toml"), "utf8") + '\n[review.agents.r2]\ncmd = ["claude", "-p"]\n');
    expect(raw(["task", "claim", "T1", "--as", "r1"]).status).toBe(0);
    const r = raw(["review", "watch", "7", "--task", "T1", "--once"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("DISPATCHED");
    const m = JSON.parse(readFileSync(join(home, "workers", `review-7-${head.slice(0, 12)}`, "worker.json"), "utf8"));
    expect(m.argv.slice(2)).toEqual([join(tools, "claude"), "-p"]);
    const probes = readFileSync(log, "utf8");
    expect(probes).toContain("claude\nauth\nstatus\n");
    expect(probes).not.toContain("codex\n"); // the unselected, logged-out reviewer is not what admission checks
  });
  it.each([["gemini", "-p"], "claude -p"])("review dry run refuses the same reviewer as once: %j", (bad) => {
    const head = "b".repeat(40);
    fake("gemini");
    fake("gh", `case "$1 $2" in "pr view") printf '%s\\n' '{"headRefOid":"${head}","state":"OPEN","comments":[]}';; "api --paginate") case "$3" in */check-runs) printf '%s\\n' '["${head}","ci","success"]';; esac;; esac`);
    reviewer = bad;
    configure();
    expect(raw(["task", "claim", "T1", "--as", "author"]).status).toBe(0);
    const dry = raw(["review", "watch", "7", "--task", "T1", "--dry-run", "--json"]);
    const once = raw(["review", "watch", "7", "--task", "T1", "--once"]);
    expect([dry.status, JSON.parse(dry.stdout).outcome, JSON.parse(dry.stdout).command]).toEqual([1, "BLOCKED", null]);
    expect(once.status).toBe(1);
    expect(once.stdout).toContain("BLOCKED");
    expect(dry.stdout).toContain("readiness failed:");
    expect(once.stdout).toContain("readiness failed:");
    const doctor = run("doctor");
    expect(doctor.stdout).not.toMatch(/PASS\s+review agent r1/);
    expect(doctor.stdout).toMatch(/SKIP\s+review agent r1\s+(?:UNVERIFIED:|expected a non-empty argv)/);
  });
  it("plain doctor retains its concise report", () => { const r = run("doctor"); expect(r.stdout).not.toContain("ready-for-live"); expect(r.stdout).toMatch(/PASS\s+worker command/); expect(r.stdout).toMatch(/PASS\s+review agent r1/); expect(readFileSync(log, "utf8")).toContain("codex\nlogin\nstatus\n"); });
});

/** The `orch ...` lines of the README command block, comments removed. */
function readmeCommands(file: string): string[] {
  const block = /\n## (?:Commands|命令)\n+```sh\n([\s\S]*?)```/.exec(readFileSync(join(ROOT, file), "utf8"));
  expect(block, `${file} command block`).not.toBeNull();
  return block![1].split("\n").filter((l) => l.startsWith("orch ")).map((l) => l.replace(/\s+#.*$/, "").trim());
}
const words = (line: string): string[] => (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ""));

describe("ReadmeQuickstart", () => {
  it("README command block runs as documented against the packed CLI", () => {
    const en = readmeCommands("README.md");
    const shape = (l: string) => l.replace(/"[^"]*"/g, '""');
    expect(readmeCommands("README.zh.md").map(shape)).toEqual(en.map(shape));
    // Documented outcomes after a plain `orch init`: everything exits 0 except these three.
    const documented: Record<string, [number, string]> = {
      "orch mem search review": [1, ""], // a fresh home has no note to match
      "orch doctor --ready --agent claude": [1, "ready-for-live: NOT READY"],
      "orch worker start w1 --agent claude --worktree --task task.md": [2, "worker: readiness failed: "],
    };
    for (const line of Object.keys(documented)) expect(en).toContain(line);
    const qs = join(repo, "..", "quickstart-home"); mkdirSync(qs);
    expect(spawnSync(gitTool, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
    writeFileSync(join(repo, "task.md"), "do the task\n");
    for (const line of en) {
      const r = raw(words(line).slice(1), qs);
      const [code, text] = documented[line] ?? [0, ""];
      expect(r.status, `${line}\n${r.stdout}${r.stderr}`).toBe(code);
      expect(r.stdout + r.stderr).toContain(text);
    }
    expect(existsSync(join(qs, "workers", "w1"))).toBe(false);
    // The prerequisites the README names turn the same two commands green.
    const cfg = join(qs, "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace('repo = ""', 'repo = "example/trial"') + '\n[review.agents.r1]\ncmd = ["codex", "exec", "-"]\n');
    writeFileSync(join(qs, "load.json"), JSON.stringify({ tier: "NORMAL", ts: Date.now() / 1000, load_ratio: 0, swap_pct: 0 }));
    const ready = raw(["doctor", "--ready", "--agent", "claude"], qs);
    expect(ready.status, ready.stdout + ready.stderr).toBe(0);
    expect(ready.stdout).toContain("ready-for-live: READY (unattended-ready)");
    const started = raw(["worker", "start", "w1", "--agent", "claude", "--worktree", "--task", "task.md"], qs);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.stdout).toContain("worker w1 started");
  });
});

describe("ReadinessProbeAndRules", () => {
  it("a null auth probe result is NOT READY", () => {
    const probes = { which: (c: string) => `/fake/${c}`, exitCode: () => null, output: () => null };
    const rows = readiness({ workers: { command: ["claude", "-p"] }, review: { agents: { r1: { cmd: ["codex", "exec", "-"] } } } }, "/absent/load.json", {}, probes);
    for (const name of ["worker auth", "reviewer auth"]) {
      const row = rows.find((r) => r.name === name)!;
      expect(row.ok, name).toBe(false);
      expect(row.unverified, name).toBeUndefined();
      expect(row.detail).toContain("could not run");
    }
    expect(render(rows).at(-1)).toContain("ready-for-live: NOT READY; failing checks: ");
  });
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
    expect(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")).packages[""].engines.node).toBe(">=22");
    const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(installer).toContain('>= 22 ? 0 : 1');
    expect(installer).toContain('need Node.js >= 22');
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("Node.js 22 or newer");
    expect(readFileSync(join(ROOT, "README.zh.md"), "utf8")).toContain("Node.js 22 或更高版本");
  });
  it("every documented command assignment is admitted or marked attended-only", () => {
    const files = ["README.md", "README.zh.md", ...["docs", "templates"].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { recursive: true }).map(String).filter((file) => file.endsWith(".md")).map((file) => join(dir, file)))];
    const probes = { which: (cmd: string) => `/tool/${cmd}`, exitCode: () => 0, output: () => null };
    for (const file of files) for (const [index, line] of readFileSync(join(ROOT, file), "utf8").split("\n").entries()) {
      const match = /^\s*(?:cmd|command)\s*=\s*(.+?)(?:\s+#.*)?$/.exec(line);
      if (!match) continue;
      if (/attended-only|--force/.test(line)) continue;
      // a TOML literal string ('...') is a shell string; anything else here is an array or a basic string
      const text = match[1].trim();
      const value = text.startsWith("'") ? text.slice(1, -1) : JSON.parse(text.replaceAll("'", '"'));
      const refused = commandChecks("documented", value, {}, probes).filter((row) => !row.ok);
      expect(refused, `${file}:${index + 1}`).toEqual([]);
    }
  });
});
