// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Setup composes installers. It owns no installed files or completion markers. */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { type Args, type CmdSpec, type OptSpec } from "./args.js";
import type { IO } from "./cli.js";

type Result = { code: number; out: string; err: string };
export interface SetupDeps {
  tree: CmdSpec<any>;
  platform?: NodeJS.Platform;
  cwd?: string;
  run?: (argv: string[], cwd: string) => Result;
  checkWorkspace?: (path: string) => void;
}

const PRESETS = ["coding", "research", "ops"];
const SCOPES = ["workspace", "user"];
export function setupSpec(run: (a: Args, io: IO) => Promise<number>): CmdSpec<typeof run> {
  const opt = (dest: string, kind: "str" | "bool", help: string, choices?: string[]): OptSpec =>
    ({ dest, flags: [`--${dest.replaceAll("_", "-")}`], kind, help, ...(choices ? { choices } : {}) });
  return { name: "setup", help: "set up a workspace for a Claude Code lead", run, opts: [
    opt("workspace", "str", "workspace folder (default: current folder)"),
    opt("preset", "str", "Claude permissions preset (default: coding)", PRESETS),
    opt("scope", "str", "host settings and skills destination (default: workspace)", SCOPES),
    opt("yes", "bool", "accept defaults; background service stays off"),
    opt("dry_run", "bool", "print all commands without running them or writing files"),
  ] };
}

function has(tree: CmdSpec<any>, names: string[]): boolean {
  let node: CmdSpec<any> | undefined = tree;
  for (const name of names) node = node?.sub?.find(s => s.name === name);
  return Boolean(node);
}

function runCli(argv: string[], cwd: string): Result {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), ...argv], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.error?.message ?? r.stderr ?? r.signal ?? "" };
}

const commandText = (argv: string[]) => "orch " + argv.map(s => /^[\w./:\\-]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`).join(" ");
function json(out: string): any {
  try { return JSON.parse(out); } catch { return null; }
}

/** Recognize each sibling command's public status result, rather than guessing from files. */
function installed(name: string, r: Result): boolean {
  if (r.code !== 0) return false;
  if (name === "lead") return /^result: INSTALLED$/m.test(r.out);
  if (name === "host") {
    const rows = r.out.trim().split("\n").filter(s => /^(permission |hook |agreement:)/.test(s));
    return rows.some(s => s.startsWith("agreement:")) && rows.every(s => /: INSTALLED$/.test(s));
  }
  const data = json(r.out);
  if (name === "service") return data?.outcome === "STATUS" && Array.isArray(data.jobs) && data.jobs.length > 0 && data.jobs.every((j: any) => j.loaded === true);
  return Array.isArray(data?.skills) && data.skills.length > 0 && data.skills.every((s: any) => s.state === "installed");
}

type Step = { name: string; argv: string[]; check?: string[]; selected: boolean };
type Row = { name: string; state: "DONE" | "SKIPPED" | "UNAVAILABLE" | "FAILED"; reason: string };

export async function runSetup(a: Args, io: IO, deps: SetupDeps): Promise<number> {
  const platform = deps.platform ?? a._platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const cwd = deps.cwd ?? process.cwd();
  const emit = (s: string) => io.out(s + "\n");
  let workspace = a.workspace ?? cwd, preset = a.preset ?? "coding", scope = a.scope ?? "workspace", service = false;
  const interactive = !a.yes && !a.dry_run && Boolean(io.isTTY?.() && io.ask);
  const ask = (question: string, fallback: string, choices?: string[]): string => {
    for (let i = 0; i < 3; i++) {
      const answer = io.ask!(`${question} [default: ${fallback}] `);
      if (answer === null) throw Error("setup cancelled before any commands ran");
      const value = (choices ? answer.trim().toLowerCase() : answer.trim()) || fallback;
      if (!choices || choices.includes(value)) return value;
      emit(`Please choose ${choices.join(" or ")}.`);
    }
    throw Error("no valid answer; setup cancelled before any commands ran");
  };
  try {
    if (interactive) {
      if (!a.workspace) workspace = ask("Workspace folder?", cwd);
      if (!a.preset) preset = ask("Preset: coding, research, or ops?", "coding", PRESETS);
      if (!a.scope) scope = ask("Install host settings and skills for this workspace or your user?", "workspace", SCOPES);
      service = ["yes", "y"].includes(ask("Install the background service?", "no", ["yes", "y", "no", "n"]).toLowerCase());
    }
    if (!PRESETS.includes(preset) || !SCOPES.includes(scope)) throw Error("invalid preset or scope");
    workspace = paths.resolve(cwd, workspace);
  } catch (e) {
    io.err(`setup: ${(e as Error).message}\n`);
    return 2;
  }

  const hostArgs = ["--workspace", workspace, "--host", "claude"];
  const steps: Step[] = [
    { name: "init", argv: ["init", "--no-profile"], selected: true },
    { name: "lead", argv: ["lead", "install", ...hostArgs], selected: true },
    { name: "host", argv: ["host", "install", ...hostArgs, "--preset", preset, "--scope", scope], selected: true },
    { name: "service", argv: ["service", "install"], selected: service },
    { name: "skills", argv: ["skills", "install", "--host", "claude", "--scope", scope], selected: true },
  ];
  for (const step of steps.slice(1)) {
    if (has(deps.tree, [step.name, "status"])) {
      step.check = [...step.argv]; step.check[1] = "status";
      if (step.name === "skills") step.check.push("--json");
    }
  }
  emit(`Setup plan for ${workspace} (${platform}; preset ${preset}; scope ${scope})`);
  emit("Commands run in this workspace. Config and the service use your ORCH home; the lead pack stays in the workspace.");
  for (const step of steps) {
    const available = has(deps.tree, step.name === "init" ? ["init"] : [step.name, "install"]);
    emit(`  ${step.name}: ${commandText(step.argv)}${!available ? " — UNAVAILABLE (command not in this build)" : !step.selected ? " — optional, not selected" : ""}`);
    if (step.check && available) emit(`    check first: ${commandText(step.check)}`);
  }
  if (a.dry_run) { emit("Dry run: no commands ran and no files were written."); return 0; }
  if (!a.yes && !interactive) {
    io.err("setup: no interactive terminal; rerun with --yes to accept these defaults. Use --dry-run to preview.\n");
    return 2;
  }
  try {
    (deps.checkWorkspace ?? ((p) => { if (!statSync(p).isDirectory()) throw Error("workspace must be a folder"); }))(workspace);
  } catch (e) {
    io.err(`setup: workspace cannot be used: ${(e as Error).message}; no commands ran.\n`);
    return 2;
  }

  const run = deps.run ?? runCli;
  const rows: Row[] = [];
  let failed = "";
  for (const step of steps) {
    const add = (state: Row["state"], reason: string) => { rows.push({ name: step.name, state, reason }); emit(`${step.name}: ${state}${reason ? ` (${reason})` : ""}`); };
    if (failed) { add("SKIPPED", `blocked because ${failed} failed; fix it and rerun setup`); continue; }
    if (!has(deps.tree, step.name === "init" ? ["init"] : [step.name, "install"])) { add("UNAVAILABLE", "command not in this build"); continue; }
    if (!step.selected) { add("SKIPPED", "background service not selected"); continue; }
    try {
      let already = false;
      if (step.check) {
        const checked = run(step.check, workspace);
        const data = json(checked.out);
        if (data?.outcome === "UNAVAILABLE") { add("UNAVAILABLE", data.reason || `no adapter for ${platform}`); continue; }
        if (checked.code !== 0 || ["ERROR", "CONFLICT"].includes(data?.outcome)) {
          failed = step.name;
          add("FAILED", `status check: ${checked.err.trim() || data?.reason || checked.out.trim() || `command exited ${checked.code}`}; inspect with ${commandText(step.check)}`);
          continue;
        }
        already = installed(step.name, checked);
        // Service status cannot prove ownership; install verifies it before we report a skip.
        if (already && step.name !== "service") { add("SKIPPED", "already installed"); continue; }
      }
      const result = run(step.argv, workspace);
      const data = json(result.out);
      if (data?.outcome === "UNAVAILABLE") { add("UNAVAILABLE", data.reason || `no adapter for ${platform}`); continue; }
      if (result.code !== 0 || ["ERROR", "CONFLICT"].includes(data?.outcome) || (step.name === "skills" && /kept.*(?:modified|unowned)/i.test(result.out))) {
        failed = step.name;
        add("FAILED", result.err.trim() || data?.reason || result.out.trim() || `command exited ${result.code}`);
        continue;
      }
      if (step.name === "service" && data?.reason === "Scheduler disabled") { add("SKIPPED", data.reason); continue; }
      if (step.name === "init") already = /^config exists\b/m.test(result.out) && !/^wrote /m.test(result.out);
      add(already ? "SKIPPED" : "DONE", already ? "already installed" : data?.reason || "");
    } catch (e) {
      failed = step.name;
      add("FAILED", (e as Error).message);
    }
  }
  const labels: Record<string, string> = { init: "local settings and role handbook", lead: "lead instructions", host: "Claude permissions and hooks", service: "background service", skills: "assistant skills" };
  emit("\nSetup summary:");
  for (const row of rows) emit(`  ${labels[row.name]}: ${row.state}${row.reason ? ` — ${row.reason}` : ""}`);
  if (failed) emit(`Setup stopped at ${failed}. Fix the reason above and rerun orch setup with the same options.`);
  emit(`${failed ? "After that, open" : "Next: open"} Claude Code in ${workspace} and say "boot the lead".`);
  return failed ? 1 : 0;
}
