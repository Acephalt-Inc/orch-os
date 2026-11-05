// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "host-cli-")); dirs.push(dir); return dir; };
const io = (input = "") => {
  const result = { stdout: "", stderr: "", stdin: () => input,
    out: (s: string) => { result.stdout += s; }, err: (s: string) => { result.stderr += s; } };
  return result;
};

it("root help and host help expose the commands without reading config", async () => {
  const output = io();
  expect(await main(["--help"], output)).toBe(0);
  expect(output.stdout).toContain("host");
  expect(output.stdout).toContain("hook");
  const host = io();
  expect(await main(["host", "install", "--help"], host)).toBe(0);
  expect(host.stdout).toContain("--scope");
  expect(host.stdout).toContain("--preset");
  const hook = io();
  hook.stdin = () => { throw new Error("help must not read stdin"); };
  expect(await main(["hook", "-h"], hook)).toBe(0);
  expect(hook.stdout).toContain("--workspace");
});

it("public host CLI dry run writes nothing and unsupported hosts are usage errors", async () => {
  const workspace = temp();
  const output = io();
  expect(await main(["host", "install", "--workspace", workspace, "--host", "claude", "--dry-run"], output)).toBe(0);
  const invalid = io();
  expect(await main(["host", "install", "--workspace", workspace, "--host", "codex"], invalid)).toBe(2);
});

it("public hook CLI returns the documented refusal and leaves normal tools alone", async () => {
  const blocked = io(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 31" } }));
  expect(await main(["hook", "pre-tool-guard"], blocked)).toBe(2);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr).toContain("background");
  const allowed = io(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }));
  expect(await main(["hook", "pre-tool-guard"], allowed)).toBe(0);
  expect(allowed.stderr).toBe("");
});

it("built settings invoke the Node hook entrypoint with stdin and paths containing spaces", () => {
  const root = temp();
  const home = join(root, "home");
  const workspace = join(root, "project space");
  mkdirSync(home); mkdirSync(workspace);
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORCH_HOME: join(home, "absent-config") };
  const cli = join(process.cwd(), "dist", "cli.js");
  const installed = spawnSync(process.execPath, [cli, "host", "install", "--workspace", workspace, "--host", "claude"], { env, encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  expect(readFileSync(join(workspace, ".claude", "CLAUDE.md"), "utf8")).toContain("irreversible or outward-facing actions");
  const settings = JSON.parse(readFileSync(join(workspace, ".claude", "settings.json"), "utf8"));
  const hook = settings.hooks.PreToolUse.at(-1).hooks[0];
  const result = spawnSync(hook.command, hook.args, { env, encoding: "utf8", input: JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh run watch 42" }, cwd: workspace,
  }) });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("background");
  const uninstalled = spawnSync(process.execPath, [cli, "host", "uninstall", "--workspace", workspace, "--host", "claude"], { env, encoding: "utf8" });
  expect(uninstalled.status, uninstalled.stderr).toBe(0);
});
