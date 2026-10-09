import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as S from "../src/schedule.js";

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
    expect(text.match(/<string>/g)).toHaveLength(6); // label plus five command words
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
    expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.output.out).toBe("unchanged brief\n"); expect([...f.files]).toEqual(before); expect(f.calls).toEqual([]);
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
    const f = fixture(); S.install(f.host, f.io, f.args, f.cfg); expect(S.runScheduled(f.host, f.io, "brief", { config: () => f.cfg, sample() {}, start(_c, _n, opts) { expect(opts.force).toBeUndefined(); throw Error("load tier NORMAL: start refused"); }, limit: () => 1 })).toBe(1); expect([...f.files.values()].join("\n")).toContain("REFUSED load tier");
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
    const f = fixture("linux"); f.host.node = '/n space&<"%'; f.host.envOrchHome = '/o space&<"%'; expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); const text = [...f.files.values()].join("\n"); expect(text).toContain('/n space&<\\"%%'); expect(text).toContain('/o space&<\\"%%');
  });

  it("dry run writes and runs nothing", () => { const f = fixture(); f.args.dry_run = true; expect(S.install(f.host, f.io, f.args, f.cfg)).toBe(0); expect(f.output.out).toContain("launchctl bootstrap"); expect(f.files.size).toBe(0); expect(f.calls).toEqual([]); });
});
