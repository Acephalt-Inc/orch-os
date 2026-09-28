// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Configuration: everything deployment-specific lives in $ORCH_HOME/config.toml.
 *
 * ORCH_HOME defaults to ~/.orch. `orch init` writes the file below; every value can be edited.
 * A v1.1 config (no [messages], [tasks], [mem] or [handbook] tables) still works: every
 * missing key falls back to the default shown here.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./detect.js";
import { parseToml } from "./toml.js";
import { expandPath } from "./util.js";

export function orchHome(): string {
  const h = process.env.ORCH_HOME;
  return expandPath(h ? h : join(process.env.HOME || homedir(), ".orch"));
}

export function configPath(): string {
  return join(orchHome(), "config.toml");
}

function tomlList(items: string[]): string {
  return "[" + items.map((i) => JSON.stringify(i)).join(", ") + "]";
}

/** The default config. `agents` = detect.installed() rows; none => no worker command. */
export function renderDefault(home: string, agents: Agent[] = [], defaultAgent?: string | null): string {
  const chosen = agents.find((a) => a.name === defaultAgent) ?? agents[0];
  let block = "";
  if (agents.length) {
    block = "\n# Agent CLIs found by `orch init` (absolute paths; re-run `orch init --force` after\n" +
      "# installing another). Edit a command to add flags, e.g. a permission mode.\n";
    for (const a of agents) block += `\n[agents.${a.name}]\n# ${a.label}\ncommand = ${tomlList(a.command ?? [])}\n`;
  }
  const workerCommand = chosen ? tomlList(chosen.command ?? []) : "[]";
  const def = chosen ? chosen.name : "none found";
  const h = (rel: string) => JSON.stringify(home + rel);
  return `# ORCH-os configuration, written by \`orch init\`. Edit freely: \`orch config\` prints the
# resolved values and \`orch doctor\` checks them.

[orch]
# Free-form label for this team or project.
team = "my-team"

[mailbox]
# The shared Markdown mailbox every session and worker posts to (lock-serialized).
path = ${h("/mailbox.md")}
sections = ["LEAD", "WORKER", "REVIEWER", "SYSTEM"]

[lease]
# Single-holder role lease: one session at a time holds the lead role.
path = ${h("/lease.json")}
default_seconds = 3600
min_seconds = 60

[messages]
# Addressed agent-to-agent messages: one JSON object per line, plus one read cursor per reader.
path = ${h("/messages.jsonl")}
cursors = ${h("/cursors")}
# How often \`orch msg watch\` polls for new messages, in seconds.
poll_seconds = 5

[tasks]
# Task claim registry: one lease file per task id, so a task has exactly one holder.
dir = ${h("/tasks")}
default_seconds = 7200
min_seconds = 60

[mem]
# Long-lived notes: one Markdown file per entry and a generated INDEX.md.
dir = ${h("/mem")}
# INDEX.md is meant to be read at every session start; \`orch mem add\` warns at this many lines.
index_max_lines = 200

[handbook]
# Where \`orch init\` writes the role boot files and the handbook.
dir = ${h("/handbook")}

[merge]
# Merge gate on GitHub reviews. repo = "owner/name" for live mode (needs the \`gh\` CLI).
repo = ""
# Non-author approvals required at the PR's current head commit.
required_approvals = 1
# Label the PR must also carry ("" = no label required).
required_label = ""

[workers]
# Each worker is a detached process in its own process group, with one directory under root.
root = ${h("/workers")}
# Default worker command; the task file is fed on stdin. Placeholders: {name} {workdir}.
# \`orch init\` sets it to the first agent CLI it detects (${def}). Empty = pass one after --.
# \`orch worker start NAME --agent <name>\` uses an [agents.<name>] command instead.
command = ${workerCommand}
timeout_minutes = 60
nice = 5
# Refuse new workers while the load governor reports one of these tiers (override: --force).
block_tiers = ["HIGH", "CRITICAL"]
# \`orch worker start NAME --worktree\` gives the worker its own git worktree here, on branch
# <worktree_branch_prefix><NAME> unless --branch is given.
worktree_root = ${h("/worktrees")}
worktree_branch_prefix = "orch/"

[load]
state = ${h("/load.json")}
# load_ratio = 1-minute load average / CPU count. swap_pct = swap in use, percent.
busy = { load_ratio = 0.75 }
high = { load_ratio = 1.0, swap_pct = 90.0 }
critical = { load_ratio = 1.5 }
# Optional: a shell command that prints the CPU temperature in degrees C. Empty = not used.
# Add temp_c thresholds to busy/high/critical when you set it.
temp_command = ""
# With act = true, HIGH/CRITICAL lower the priority of processes whose command line matches
# renice_pattern (a regex; empty = none). Nothing is ever killed.
renice_pattern = ""
act = false
${block}`;
}

export function load(path?: string): Record<string, any> {
  return parseToml(readFileSync(path ?? configPath(), "utf8"));
}

/** Config if present, else the defaults (so read-only commands work before init). */
export function loadOrDefault(): Record<string, any> {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "ENOENT") return parseToml(renderDefault(orchHome()));
    throw e;
  }
}

/** A config value that is not usable: the CLI reports it with the key and exits 2. */
export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}

/**
 * A numeric config value (a number, or a string holding one, as v1.1 accepted), or a
 * ConfigError naming the key. Never NaN: a bad value must not reach a state file.
 */
export function configNumber(v: unknown, dflt: number, key: string, min = 0): number {
  let n = NaN;
  if (v === undefined || v === null) n = dflt;
  else if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${key} must be a number >= ${min} (got ${JSON.stringify(v)})`);
  return n;
}

export function expand(p: string): string {
  return expandPath(p);
}
