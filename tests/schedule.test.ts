// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as S from "../src/schedule.js";
import { buildTree } from "../src/cli.js";
import { parse } from "../src/args.js";

function fixture(platform = "darwin") {
  const root = mkdtempSync(join(tmpdir(), "orch-schedule-")), home = join(root, "home"), oh = join(root, "orch"), task = join(root, "task.txt");
  mkdirSync(home); writeFileSync(task, "morning brief\n");
  const files = new Map<string, string>(), calls: [string, string[]][] = [], results: S.Result[] = [];
  const host: S.Host = {
    platform, home, orchHome: oh, uid: 501, node: "/node", cli: "/dist/cli.js", managerAvailable: () => true,
    run(tool, args) { calls.push([tool, args]); return results.shift() ?? { code: 0, out: tool === "launchctl" ? "state = running" : args.includes("is-enabled") ? "enabled\n" : args.includes("is-active") ? "active\n" : "", err: "" }; },
    exists: (p) => files.has(p) || p === "/node" || p === "/dist/cli.js",
    lstat: (p) => { if (p === task) return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; if (p === root) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }; if (!files.has(p)) throw Error("missing"); return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; },
    read: (p) => { const x = files.get(p); if (x === undefined) throw Error("missing"); return x; }, write: (p, t) => { files.set(p, t); }, append: (p, t) => files.set(p, (files.get(p) ?? "") + t), mkdir() {}, remove: (p) => { files.delete(p); },
    list: (p) => [...files.keys()].filter((x) => x.startsWith(p + "/") && !x.slice(p.length + 1).includes("/")).map((x) => x.slice(p.length + 1)),
  };
  const output = { out: "", err: "" }, io = { out: (s: string) => output.out += s, err: (s: string) => output.err += s };
  const args = { name: "brief", daily: "07:30", task, agent: "a1", workdir: root, dry_run: false };
  return { root, task, files, calls, results, host, output, io, args, cfg: { agents: { a1: { command: ["agent"] } }, workers: { command: [] } } };
}

describe("schedule", () => {
  it("install writes one plist and bootstraps it", () => {
    const f = fixture(); expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0);
    expect(f.output.out).toBe("scheduled brief daily 07:30 (launchd)\n");
    const text = [...f.files].find(([p]) => p.endsWith(".plist"))![1];
    expect(text).toContain("<integer>7</integer>"); expect(text).toContain("<integer>30</integer>");
    expect(text.match(/<string>/g)).toHaveLength(7); // label, five command words and ORCH_HOME
    expect(f.calls).toEqual([["launchctl", ["bootstrap", "gui/501", expect.stringMatching(/brief\.plist$/)]]]);
  });

  it("systemd install reloads before enabling and stops on a failed reload", () => {
    const f = fixture("linux"); expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0);
    expect([...f.files.values()].join("\n")).toContain("OnCalendar=*-*-* 07:30:00\nPersistent=true");
    expect(f.calls.map((x) => x[1].slice(1))).toEqual([["daemon-reload"], ["enable", "--now", "orch-os-schedule-brief.timer"]]);
    const g = fixture("linux"); g.results.push({ code: 1, out: "", err: "reload broke" }); expect(S.install(g.host, g.io, g.args, g.cfg)).toBe(1); expect(g.calls).toHaveLength(1);
  });

  it("second identical install changes nothing", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); const before = [...f.files]; f.calls.length = 0; f.output.out = "";
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.output.out).toBe("unchanged brief\n"); expect([...f.files]).toEqual(before); expect(f.calls[0][0]).toBe("launchctl");
  });

  it("changed install replaces the one registration", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); f.calls.length = 0; f.args.daily = "08:00";
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.calls[0]).toEqual(["launchctl", ["bootout", "gui/501/com.orch-os.schedule.brief"]]); expect(f.calls[1][1][0]).toBe("bootstrap");
    const g = fixture(); S.install(g.host, g.io, g.args, g.cfg); g.args.daily = "08:00"; g.calls.length = 0; g.results.push({ code: 1, out: "", err: "denied" }); expect(S.install(g.host, g.io, g.args, g.cfg)).toBe(1); expect(g.calls).toHaveLength(1);
  });

  it("run samples load then starts the worker with the task on stdin", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); const order: string[] = [];
    const code = S.runScheduled(f.host, f.io, "brief", { config: () => f.cfg, sample: () => { order.push("sample"); }, start: (_c, n, o) => { order.push("start"); expect(n).toBe("sched-brief"); expect(o.force).toBeUndefined(); expect(o.task).toBe(f.task); return { pid: 42 }; }, limit: () => 3 });
    expect(code).toBe(0); expect(order).toEqual(["sample", "start"]); expect([...f.files.values()].join("\n")).toContain("STARTED pid=42");
  });

  it("run is refused exactly where worker start is refused", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); expect(S.runScheduled(f.host, f.io, "brief", { config: () => f.cfg, sample() {}, start(_c, _n, opts) { expect(opts.force).toBeUndefined(); throw Error("load tier NORMAL: start refused"); }, limit: () => 1, isRefusal: () => true })).toBe(2); expect([...f.files.values()].join("\n")).toContain("REFUSED load tier");
  });

  it.each(["LOADED", "MISSING", "ORPHAN", "ERROR"])("status reports what the operating system says: %s", (wanted) => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); f.output.out = ""; f.calls.length = 0;
    if (wanted === "MISSING") f.results.push({ code: 1, out: "", err: "not found" });
    if (wanted === "ORPHAN") for (const p of [...f.files.keys()]) if (p.endsWith(".json")) f.files.delete(p);
    if (wanted === "ERROR") { f.host.exists = (p) => p !== "/node" && (f.files.has(p) || p === "/dist/cli.js"); }
    const code = S.status(f.host, f.io); expect(f.output.out).toContain(wanted); expect(code).toBe(wanted === "LOADED" ? 0 : 1);
  });

  it("remove leaves nothing behind and never claims a failed removal", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); f.calls.length = 0; f.output.out = ""; expect(S.remove(f.host, f.io, "brief")).toBe(0); expect(f.output.out).toBe("removed brief\n"); expect(S.remove(f.host, f.io, "brief")).toBe(0);
    const g = fixture(); S.install(g.host, g.io, g.args, g.cfg); g.results.push({ code: 1, out: "", err: "denied" }); expect(S.remove(g.host, g.io, "brief")).toBe(1); expect(g.files.size).toBeGreaterThan(0);
  });

  it.each(["win32", "bad-name", "bad-time", "missing-task", "unknown-agent"])("schedule refuses and writes nothing: %s", (kind) => {
    const f = fixture(kind === "win32" ? "win32" : "darwin"); if (kind === "bad-name") f.args.name = "../x"; if (kind === "bad-time") f.args.daily = "24:00"; if (kind === "missing-task") f.args.task += ".gone"; if (kind === "unknown-agent") f.args.agent = "nope";
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(2); expect(f.files.size).toBe(0); expect(f.calls).toEqual([]);
  });

  it("unit files round-trip paths with spaces and special characters", () => {
    const f = fixture("linux"); f.host.node = '/n space$<"%'; f.host.orchHome = '/o space$<"%'; expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); const text = [...f.files.values()].join("\n"); expect(text).toContain('/n space$<\\"%%'); expect(text).toContain('ORCH_HOME=/o space$<\\"%%');
  });

  it.each(["darwin", "linux"])("dry run writes and runs nothing on %s", (platform) => { const f = fixture(platform); f.args.dry_run = true; f.host.managerAvailable = undefined; expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.files.size).toBe(0); expect(f.calls).toEqual([]); });

  it("failed registration leaves no installed state and retries", () => {
    const f = fixture(); f.results.push({ code: 1, out: "", err: "denied" });
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(1); expect(f.files.size).toBe(0);
    f.output.err = ""; expect(S.status(f.host, f.io)).toBe(0); expect(f.output.out).toContain("no scheduled jobs");
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.calls.filter(([tool, args]) => tool === "launchctl" && args[0] === "bootstrap")).toHaveLength(2);
  });

  it("distinguishes a run crash from a refusal", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg);
    expect(S.runScheduled(f.host, f.io, "brief", { config: () => f.cfg, sample() {}, start() { throw Error("bug"); }, limit: () => null, isRefusal: () => false })).toBe(1);
    expect(f.output.err).toContain("run crashed: bug"); expect([...f.files.values()].join("\n")).toContain("CRASHED bug");
  });

  it("reports JSON and systemd manager states", () => {
    const f = fixture("linux"); S.install(f.host, f.io, f.args, f.cfg); f.output.out = ""; f.calls.length = 0;
    expect(S.status(f.host, f.io, true)).toBe(0); expect(JSON.parse(f.output.out)[0]).toMatchObject({ name: "brief", state: "LOADED" });
    f.output.out = ""; f.results.push({ code: 1, out: "disabled\n", err: "" }, { code: 0, out: "active\n", err: "" });
    expect(S.status(f.host, f.io)).toBe(1); expect(f.output.out).toContain("ERROR");
  });

  it("reports unrecognised manager output and an invalid record as errors", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); f.output.out = ""; f.results.push({ code: 0, out: "surprise", err: "" });
    expect(S.status(f.host, f.io)).toBe(1); expect(f.output.out).toContain("ERROR");
    const record = [...f.files.keys()].find((p) => p.endsWith(".json"))!; f.files.set(record, "{"); f.output.out = "";
    expect(S.status(f.host, f.io)).toBe(1); expect(f.output.out).toContain("ERROR");
  });

  it("removes the named registration and status then has no job", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); f.calls.length = 0;
    expect(S.remove(f.host, f.io, "brief")).toBe(0); expect(f.calls[0]).toEqual(["launchctl", ["bootout", "gui/501/com.orch-os.schedule.brief"]]);
    f.output.out = ""; expect(S.status(f.host, f.io)).toBe(0); expect(f.output.out).toBe("no scheduled jobs\n");
  });

  it("never removes or overwrites a job with only the marker", () => {
    const f = fixture(); const path = join(f.host.home, "Library/LaunchAgents/com.orch-os.schedule.brief.plist"); f.files.set(path, "<!-- Managed by orch schedule -->\nforeign\n");
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(2); expect(f.files.get(path)).toContain("foreign");
    f.files.set(join(f.host.orchHome, "schedule/brief.json"), JSON.stringify({ name: "brief", daily: "07:30", task: f.task, agent: "a1", workdir: f.root, node: "/node", cli: "/dist/cli.js", orchHome: f.host.orchHome }));
    expect(S.remove(f.host, f.io, "brief")).toBe(1); expect(f.files.get(path)).toContain("foreign"); expect(f.calls).toEqual([]);
  });

  it.each(["status", "remove", "run"])("refuses %s on Windows", (action) => {
    const f = fixture("win32"); const code = action === "status" ? S.status(f.host, f.io) : action === "remove" ? S.remove(f.host, f.io, "brief") : S.runScheduled(f.host, f.io, "brief", { config: () => ({}), sample() {}, start: () => ({}), limit: () => null });
    expect(code).toBe(2); expect(f.output.err.split("\n").filter(Boolean)).toHaveLength(1); expect(f.calls).toEqual([]);
  });

  it("refuses Linux without a user manager and exact invalid inputs", () => {
    const f = fixture("linux"); f.host.managerAvailable = () => false; expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(2); expect(f.files.size).toBe(0);
    for (const [name, daily] of [["a@b", "07:30"], ["brief", "7:5"]]) { const g = fixture(); g.args.name = name; g.args.daily = daily; expect(S.install(g.host, g.io, g.args, g.cfg)).toBe(2); }
    const g = fixture(); g.args.task = g.root; expect(S.install(g.host, g.io, g.args, g.cfg)).toBe(2);
  });

  it("the filesystem host refuses a symbolic-link record without following it", () => {
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); const text = [...f.files.values()].find((x) => x.startsWith("{"))!;
    const root = mkdtempSync(join(tmpdir(), "orch-links-")), target = join(root, "target"), link = join(root, "link"); writeFileSync(target, text); symlinkSync(target, link);
    const h = S.nodeHost("dist/cli.js"); expect(() => h.readNoFollow!(link)).toThrow();
  });

  it("built schedule commands work with an empty PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-empty-path-")), empty = join(root, "empty"); mkdirSync(empty);
    const run = (args: string[]) => spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], { encoding: "utf8", env: { ...process.env, PATH: empty, ORCH_HOME: join(root, "orch"), HOME: root } });
    expect(run(["schedule", "--help"]).status).toBe(0);
    const status = run(["schedule", "status"]); expect(status.status).toBe(0); expect(status.stdout).toBe("no scheduled jobs\n");
    const refused = run(["schedule", "install", "a@b", "--daily", "07:30", "--task", "x"]); expect(refused.status).toBe(2); expect(refused.stderr.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("runs the real CLI wiring with task stdin, load sample, and worker limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-real-run-")), home = join(root, "orch"), schedule = join(home, "schedule"), task = join(root, "task.txt"), received = join(root, "received.txt"), agent = join(root, "agent.mjs");
    mkdirSync(schedule, { recursive: true }); writeFileSync(task, "real task text\n");
    writeFileSync(agent, `import {readFileSync,writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(received)},readFileSync(0,"utf8"));setTimeout(()=>{},3000);\n`);
    writeFileSync(join(home, "config.toml"), `[workers]\nroot = ${JSON.stringify(join(home, "workers"))}\nblock_tiers = []\ntimeout_minutes = 0\n[agents.test]\ncommand = [${JSON.stringify(process.execPath)}, ${JSON.stringify(agent)}]\n[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n[profile.accounts]\na1 = "node"\n[profile.agents]\ntest = "a1"\n`);
    const base = { daily: "07:30", task, agent: "test", workdir: root, node: process.execPath, cli: resolve("dist/cli.js"), orchHome: home };
    for (const name of ["brief", "second"]) writeFileSync(join(schedule, `${name}.json`), JSON.stringify({ ...base, name }, null, 2) + "\n");
    const run = (name: string) => spawnSync(process.execPath, [resolve("dist/cli.js"), "schedule", "run", name], { encoding: "utf8", env: { ...process.env, ORCH_HOME: home } });
    expect(run("brief").status).toBe(0);
    for (let i = 0; i < 40 && !existsSync(received); i++) await new Promise((done) => setTimeout(done, 25));
    expect(readFileSync(received, "utf8")).toBe("real task text\n"); expect(existsSync(join(home, "load.json"))).toBe(true);
    const limited = run("second"); expect(limited.status).toBe(2); expect(limited.stderr).toContain("max_workers is 1");
  });

  it("every documented schedule command parses", () => {
    const lines = [readFileSync("docs/commands.md", "utf8"), readFileSync("README.md", "utf8")].flatMap((text) => text.split("\n")).filter((line) => line.trimStart().startsWith("orch schedule "));
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) {
      let command = line.split("#")[0].trim().replace(/\s+\[[^\]]+\]/g, "").replace("NAME", "brief").replace("HH:MM", "07:30").replace("FILE", "task.txt");
      command = command.replace(/\[--json\]/g, "");
      expect(() => parse(buildTree(), command.split(/\s+/).slice(1))).not.toThrow();
    }
  });
});
