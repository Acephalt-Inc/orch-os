// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Agent-CLI detection for `orch init`, `orch agents` and `orch doctor`.
 *
 * Each known agent is a coding-agent CLI that can run one task headless with the task text on
 * stdin. Detection looks on PATH first, then in a few common install directories that login
 * shells add but cron and other schedulers do not (override with ORCH_AGENT_DIRS, separated
 * like PATH: colons, or semicolons on Windows; set it to an empty string to search PATH only).
 * On Windows the common directories are per-user ones only, and a directory that is not fully
 * qualified (no drive, or relative) is never searched. The worker command is
 * written with the ABSOLUTE binary path (symlinks kept, so an agent upgrade that swaps the link
 * target does not break it), so a worker started from a minimal environment still finds it.
 *
 * Each template follows the CLI's documented non-interactive mode and is written to
 * config.toml, where you can edit it (for example to add permission or model flags).
 */
import { delimiter, resolve } from "node:path";
import { expandPath, isWindowsSearchDir, which } from "./util.js";

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

/**
 * The common install directories. Windows gets per-user locations only: `/usr/local/bin` there
 * means `\usr\local\bin` on the current drive, a folder any local user can usually create.
 */
export function defaultDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== "win32") return DEFAULT_DIRS;
  return ["~/.local/bin", "~/.claude/local", ...(env.APPDATA ? [`${env.APPDATA}\\npm`] : [])];
}

export function searchDirs(platform: NodeJS.Platform = process.platform): string[] {
  const raw = process.env.ORCH_AGENT_DIRS;
  const dirs = raw === undefined ? defaultDirs(platform) : raw.split(platform === "win32" ? ";" : delimiter).filter((d) => d);
  const expanded = dirs.map((d) => expandPath(d));
  return platform === "win32" ? expanded.filter(isWindowsSearchDir) : expanded;
}

/** [absolute path or null, found on PATH?] */
export function find(binary: string, platform: NodeJS.Platform = process.platform): [string | null, boolean] {
  const p = which(binary, undefined, platform);
  if (p) return [resolve(p), true];
  for (const d of searchDirs(platform)) {
    const c = which(binary, d, platform);
    if (c) return [resolve(c), false];
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
