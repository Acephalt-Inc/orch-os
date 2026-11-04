// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetup } from "../src/setup.js";
import type { CmdSpec } from "../src/args.js";
import { DIST_CLI } from "./_helpers.js";

const leaf = (name: string): CmdSpec<any> => ({ name, help: "" });
const group = (name: string): CmdSpec<any> => ({ name, help: "", sub: [leaf("install"), leaf("status")] });
const tree = (): CmdSpec<any> => ({ name: "orch", help: "", sub: [leaf("init"), ...["lead", "host", "service", "skills"].map(group)] });
const args = (extra: Record<string, unknown> = {}) => ({ _path: ["orch", "setup"], ...extra });
type Result = { code: number; out: string; err: string };
function harness(options: { answers?: string[]; tty?: boolean; respond?: (argv: string[]) => Result; spec?: CmdSpec<any>; platform?: NodeJS.Platform; cwd?: string } = {}) {
  let out = "", err = "";
  const answers = [...(options.answers ?? [])];
  const calls: { argv: string[]; cwd: string }[] = [];
  let questions = 0;
  const io = { out: (s: string) => { out += s; }, err: (s: string) => { err += s; }, stdin: () => "", isTTY: () => options.tty ?? true, ask: () => { questions++; return answers.shift() ?? null; } };
  const deps = { tree: options.spec ?? tree(), platform: options.platform ?? "darwin" as NodeJS.Platform, cwd: options.cwd ?? "/work", checkWorkspace: (_path: string) => {}, run: (argv: string[], cwd: string) => {
    calls.push({ argv, cwd });
    return options.respond?.(argv) ?? { code: 0, out: "", err: "" };
  } };
  return { io, deps, calls, output: () => out + err, questions: () => questions };
}

describe("setup", () => {
  it.each([
    ["darwin", "/work", "work space", "/work/work space"],
    ["win32", "C:\\work", "work space", "C:\\work\\work space"],
  ] as const)("runs the full plan with %s paths", async (platform, cwd, workspace, resolved) => {
    const h = harness({ platform, cwd, answers: ["yes"] });
    expect(await runSetup(args({ workspace, preset: "research", scope: "user" }), h.io, h.deps)).toBe(0);
    const installs = h.calls.filter(c => c.argv[0] === "init" || c.argv[1] === "install");
    expect(installs.map(c => c.argv)).toEqual([
      ["init", "--no-profile"],
      ["lead", "install", "--workspace", resolved, "--host", "claude"],
      ["host", "install", "--workspace", resolved, "--host", "claude", "--preset", "research", "--scope", "user"],
      ["service", "install"],
      ["skills", "install", "--host", "claude", "--scope", "user"],
    ]);
    expect(installs.at(-1)?.cwd).toBe(resolved);
    expect(h.output()).toMatch(/boot the lead/i);
  });

  it("prompts for defaults and declines the service with --yes", async () => {
    const h = harness({ tty: false });
    expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(0);
    expect(h.questions()).toBe(0);
    expect(h.calls.some(c => c.argv[0] === "service")).toBe(false);
    expect(h.calls.find(c => c.argv[0] === "host" && c.argv[1] === "install")?.argv).toEqual(expect.arrayContaining(["coding", "workspace"]));
  });

  it("accepts prompt defaults and asks about service", async () => {
    const h = harness({ answers: ["", "", "", ""] });
    expect(await runSetup(args(), h.io, h.deps)).toBe(0);
    expect(h.questions()).toBe(4);
    expect(h.calls.some(c => c.argv[0] === "service")).toBe(false);
    expect(h.calls.find(c => c.argv[0] === "host" && c.argv[1] === "install")?.argv).toEqual(expect.arrayContaining(["coding", "workspace"]));
  });

  it.each([[null], ["invalid", "invalid", "invalid"]])("does not invoke commands after EOF or invalid selection", async (...answers) => {
    const h = harness({ answers: answers.filter((a): a is string => a !== null) });
    expect(await runSetup(args({ workspace: "/work" }), h.io, h.deps)).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("dry-run prints all steps without prompting, checking or executing", async () => {
    const h = harness();
    let checked = false;
    h.deps.checkWorkspace = () => { checked = true; };
    expect(await runSetup(args({ dry_run: true }), h.io, h.deps)).toBe(0);
    expect(h.questions()).toBe(0);
    expect(h.calls).toEqual([]);
    expect(checked).toBe(false);
    for (const command of ["init --no-profile", "lead install --workspace /work --host claude", "host install --workspace /work --host claude --preset coding --scope workspace", "service install", "skills install --host claude --scope workspace"]) expect(h.output()).toContain(command);
  });

  it("requires --yes without a terminal and shows the full plan", async () => {
    const h = harness({ tty: false });
    expect(await runSetup(args(), h.io, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.output()).toContain("--yes");
    for (const command of ["init --no-profile", "lead install --workspace /work --host claude", "host install --workspace /work --host claude --preset coding --scope workspace", "service install", "skills install --host claude --scope workspace"]) expect(h.output()).toContain(command);
  });

  it("continues after unavailable commands and typed unavailable results", async () => {
    const spec = tree();
    spec.sub = spec.sub!.filter(s => s.name !== "host");
    const h = harness({ spec, respond: a => a[0] === "lead" && a[1] === "install" ? { code: 1, out: JSON.stringify({ outcome: "UNAVAILABLE", reason: "unsupported" }), err: "" } : { code: 0, out: "", err: "" } });
    expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(0);
    expect(h.output()).toMatch(/host: UNAVAILABLE/);
    expect(h.output()).toMatch(/lead: UNAVAILABLE/);
    expect(h.calls.some(c => c.argv[0] === "skills" && c.argv[1] === "install")).toBe(true);
  });

  it("stops dependent steps when an install fails or throws", async () => {
    for (const throws of [false, true]) {
      const h = harness({ respond: a => {
        if (a[0] === "lead" && a[1] === "install") {
          if (throws) throw new Error("failed");
          return { code: 1, out: "", err: "failed" };
        }
        return { code: 0, out: "", err: "" };
      } });
      expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(1);
      expect(h.calls.some(c => ["host", "skills"].includes(c.argv[0]))).toBe(false);
      expect(h.output()).toMatch(/FAILED/);
      for (const step of ["host", "service", "skills"]) expect(h.output()).toMatch(new RegExp(`${step}: SKIPPED.*lead failed`, "i"));
      expect(h.output()).toMatch(/rerun/i);
    }
  });

  it("fails closed on a partial lead status and preserves its reason", async () => {
    const h = harness({ respond: a => a[0] === "lead" && a[1] === "status"
      ? { code: 2, out: "result: PARTIAL\nedited since install\n", err: "" }
      : { code: 0, out: "", err: "" } });
    expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(1);
    expect(h.output()).toMatch(/lead: FAILED/);
    expect(h.output()).toContain("edited since install");
    expect(h.calls.some(c => c.argv[0] === "lead" && c.argv[1] === "install")).toBe(false);
    expect(h.calls.some(c => ["host", "service", "skills"].includes(c.argv[0]))).toBe(false);
  });

  it("reports a disabled service as skipped after ownership verification", async () => {
    const h = harness({ answers: ["yes"], respond: a => ({ code: 0, err: "", out: a[0] === "service" ? JSON.stringify(a[1] === "status"
      ? { outcome: "STATUS", jobs: [{ loaded: false }] }
      : { outcome: "INSTALLED", reason: "Scheduler disabled" }) : "" }) });
    expect(await runSetup(args({ workspace: "/work", preset: "coding", scope: "workspace" }), h.io, h.deps)).toBe(0);
    expect(h.output()).toMatch(/service: SKIPPED.*Scheduler disabled/i);
    expect(h.output()).not.toMatch(/service: DONE/);
  });

  it("continues when service status is unavailable", async () => {
    const h = harness({ answers: ["yes"], respond: a => a[0] === "service" && a[1] === "status"
      ? { code: 1, out: JSON.stringify({ outcome: "UNAVAILABLE", reason: "no scheduler" }), err: "" }
      : { code: 0, out: "", err: "" } });
    expect(await runSetup(args({ workspace: "/work", preset: "coding", scope: "workspace" }), h.io, h.deps)).toBe(0);
    expect(h.output()).toMatch(/service: UNAVAILABLE.*no scheduler/i);
    expect(h.calls.some(c => c.argv[0] === "service" && c.argv[1] === "install")).toBe(false);
    expect(h.calls.some(c => c.argv[0] === "skills" && c.argv[1] === "install")).toBe(true);
  });

  it("rejects an unusable workspace before running any command", async () => {
    const h = harness();
    h.deps.checkWorkspace = () => { throw new Error("not a folder"); };
    expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.output()).toContain("not a folder");
  });

  it("uses status to skip installed components and verifies a loaded service", async () => {
    const h = harness({ answers: ["yes"], respond: a => {
      if (a[0] === "init") return { code: 0, out: "config exists\n", err: "" };
      if (a[1] === "status") {
        const out: Record<string, string> = { lead: "result: INSTALLED\n", host: "permission sample: INSTALLED\nhook sample: INSTALLED\nagreement: INSTALLED\n", service: JSON.stringify({ outcome: "STATUS", jobs: [{ loaded: true }] }), skills: JSON.stringify({ skills: [{ name: "sample", state: "installed" }] }) };
        return { code: 0, out: out[a[0]], err: "" };
      }
      return { code: 0, out: "", err: "" };
    } });
    expect(await runSetup(args({ workspace: "/work", preset: "coding", scope: "workspace" }), h.io, h.deps)).toBe(0);
    expect(h.calls.filter(c => c.argv[1] === "install").map(c => c.argv[0])).toEqual(["service"]);
    expect(h.calls.find(c => c.argv[0] === "skills" && c.argv[1] === "status")?.argv).toContain("--json");
    expect(h.output()).toMatch(/SKIPPED/);
  });

  it("does not claim success when skills were kept", async () => {
    const h = harness({ respond: a => ({ code: 0, out: a[0] === "skills" && a[1] === "install" ? "kept modified or unowned skills\n" : "", err: "" }) });
    expect(await runSetup(args({ yes: true }), h.io, h.deps)).toBe(1);
    expect(h.output()).toMatch(/FAILED/);
  });

  it.each([["--dry-run", 0], ["", 2]])("compiled CLI %s writes nothing without confirmation", (flag, expected) => {
    const base = mkdtempSync(join(tmpdir(), "orch-setup-plan-"));
    try {
      const workspace = join(base, "work space"), home = join(base, "home");
      mkdirSync(workspace);
      const shownWorkspace = `"${workspace.replaceAll('"', '\\"')}"`;
      const env = { ...process.env, ORCH_HOME: home, HOME: base, USERPROFILE: base };
      const result = spawnSync(process.execPath, [DIST_CLI, "setup", "--workspace", workspace, ...(flag ? [flag] : [])], { cwd: workspace, env, encoding: "utf8" });
      expect(result.status, result.stderr + result.stdout).toBe(expected);
      for (const command of ["init --no-profile", `lead install --workspace ${shownWorkspace} --host claude`, `host install --workspace ${shownWorkspace} --host claude --preset coding --scope workspace`, "service install", "skills install --host claude --scope workspace"]) expect(result.stdout + result.stderr).toContain(command);
      expect(readdirSync(base)).toEqual(["work space"]);
      expect(readdirSync(workspace)).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("compiled CLI runs init and lead idempotently", () => {
    const base = mkdtempSync(join(tmpdir(), "orch-setup-"));
    try {
      const workspace = join(base, "workspace"), home = join(base, "home");
      mkdirSync(workspace); mkdirSync(home);
      const env = { ...process.env, ORCH_HOME: home, HOME: home, USERPROFILE: home };
      const run = () => spawnSync(process.execPath, [DIST_CLI, "setup", "--workspace", workspace, "--yes", "--preset", "ops"], { cwd: workspace, env, encoding: "utf8" });
      const first = run();
      expect(first.status, first.stderr + first.stdout).toBe(0);
      const status = spawnSync(process.execPath, [DIST_CLI, "lead", "status", "--workspace", workspace, "--host", "claude"], { cwd: workspace, env, encoding: "utf8" });
      expect(status.stdout + status.stderr).toContain("result: INSTALLED");
      const config = join(home, "config.toml"), lead = join(workspace, "CLAUDE.md");
      const configBytes = readFileSync(config), leadBytes = readFileSync(lead);
      const settings = join(workspace, ".claude", "settings.json"), settingsBytes = readFileSync(settings);
      const second = run();
      expect(second.status, second.stderr + second.stdout).toBe(0);
      expect(second.stdout).toMatch(/init: SKIPPED/);
      expect(second.stdout).toMatch(/lead: SKIPPED/);
      expect(readFileSync(config)).toEqual(configBytes);
      expect(readFileSync(lead)).toEqual(leadBytes);
      const defaults = spawnSync(process.execPath, [DIST_CLI, "setup", "--yes"], {cwd: workspace, env, encoding: "utf8"});
      expect(defaults.status, defaults.stdout + defaults.stderr).toBe(0);
      expect(readFileSync(lead)).toEqual(leadBytes);
      expect(readFileSync(settings)).toEqual(settingsBytes);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("compiled CLI preserves a modified lead file and fails closed on rerun", () => {
    const base = mkdtempSync(join(tmpdir(), "orch-setup-edit-"));
    try {
      const workspace = join(base, "workspace"), home = join(base, "home");
      mkdirSync(workspace); mkdirSync(home);
      const env = { ...process.env, ORCH_HOME: home, HOME: home, USERPROFILE: home };
      const run = () => spawnSync(process.execPath, [DIST_CLI, "setup", "--workspace", workspace, "--yes"], { cwd: workspace, env, encoding: "utf8" });
      const first = run();
      expect(first.status, first.stderr + first.stdout).toBe(0);
      const lead = join(workspace, "CLAUDE.md");
      writeFileSync(lead, Buffer.concat([readFileSync(lead), Buffer.from("\nUser changes.\n")]));
      const modified = readFileSync(lead);
      const second = run();
      expect(second.status, second.stderr + second.stdout).toBe(1);
      expect(second.stdout + second.stderr).toMatch(/lead: FAILED/);
      expect(readFileSync(lead)).toEqual(modified);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("compiled setup reports an explicitly different installed preset", () => {
    const base = mkdtempSync(join(tmpdir(), "orch-setup-preset-"));
    try {
      const workspace = join(base, "workspace"), home = join(base, "home"); mkdirSync(workspace); mkdirSync(home);
      const env = { ...process.env, ORCH_HOME: home, HOME: home, USERPROFILE: home };
      const run = (extra: string[]) => spawnSync(process.execPath, [DIST_CLI, "setup", "--workspace", workspace, "--yes", ...extra], {cwd: workspace, env, encoding: "utf8"});
      expect(run(["--preset", "coding"]).status).toBe(0);
      const settings = join(workspace, ".claude", "settings.json"), before = readFileSync(settings);
      const changed = run(["--preset", "ops"]);
      expect(changed.status, changed.stdout + changed.stderr).toBe(1);
      expect(changed.stdout).toMatch(/host: FAILED.*preset/);
      expect(readFileSync(settings)).toEqual(before);
    } finally { rmSync(base, {recursive: true, force: true}); }
  });

});
