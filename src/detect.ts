// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Agent-CLI detection for `orch init`, `orch agents` and `orch doctor`.
 *
 * Each known agent is a coding-agent CLI that can run one task headless with the task text on
 * stdin. Detection looks on PATH first, then in a few common install directories that login
 * shells add but cron and other schedulers do not (override with ORCH_AGENT_DIRS,
 * colon-separated; set it to an empty string to search PATH only). The worker command is
 * written with the ABSOLUTE binary path (symlinks kept, so an agent upgrade that swaps the link
 * target does not break it), so a worker started from a minimal environment still finds it.
 *
 * Each template follows the CLI's documented non-interactive mode and is written to
 * config.toml, where you can edit it (for example to add permission or model flags).
 */
import { resolve } from "node:path";
import { expandPath, isExecutableFile, which } from "./util.js";

/** name, binary, worker command template ({bin} {workdir} {name}), label */
export const KNOWN: [string, string, string[], string][] = [
  ["claude", "claude", ["{bin}", "-p"], "Claude Code, print mode (task on stdin)"],
  ["codex", "codex", ["{bin}", "exec", "-"], "Codex CLI, exec mode (task on stdin)"],
  ["gemini", "gemini", ["{bin}"], "Gemini CLI, non-interactive when stdin is piped"],
  ["qwen", "qwen", ["{bin}"], "Qwen Code, non-interactive when stdin is piped"],
];
export const DEFAULT_DIRS = ["~/.local/bin", "~/.claude/local", "/opt/homebrew/bin", "/usr/local/bin"];

export interface Agent {
  name: string;
  binary: string;
  found: boolean;
  path: string | null;
  on_path: boolean;
  command: string[] | null;
  label: string;
  configured?: boolean;
}

export function searchDirs(): string[] {
  const raw = process.env.ORCH_AGENT_DIRS;
  const dirs = raw === undefined ? DEFAULT_DIRS : raw.split(":").filter((d) => d);
  return dirs.map((d) => expandPath(d));
}

/** [absolute path or null, found on PATH?] */
export function find(binary: string): [string | null, boolean] {
  const p = which(binary);
  if (p) return [resolve(p), true];
  for (const d of searchDirs()) {
    const c = d.replace(/\/+$/, "") + "/" + binary;
    if (isExecutableFile(c)) return [resolve(c), false];
  }
  return [null, false];
}

/** Every known agent, installed or not, in preference order. */
export function detect(): Agent[] {
  return KNOWN.map(([name, binary, tmpl, label]) => {
    const [path, onPath] = find(binary);
    const command = path ? tmpl.map((a) => (a === "{bin}" ? path : a)) : null;
    return { name, binary, found: path !== null, path, on_path: onPath, command, label };
  });
}

export function installed(): Agent[] {
  return detect().filter((a) => a.found);
}
