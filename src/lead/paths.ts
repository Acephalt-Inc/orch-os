// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The one executable path map of `orch lead`: which packaged file goes to which workspace path,
 * the reserved state paths, and the text checks on a workspace path. Pure: no file access here.
 */
import type { PlatformPath } from "node:path";

export type Host = "claude" | "codex";
export const HOSTS: readonly Host[] = ["claude", "codex"];

/** Reserved state directory, relative to the workspace. The same for either host. */
export const STATE_DIR = ".orch-lead-install";
export const MANIFEST = `${STATE_DIR}/manifest.json`;
export const MANIFEST_TMP = `${STATE_DIR}/manifest.tmp`;
export const OBJECTS_DIR = `${STATE_DIR}/objects`;
/** Written after the host directories exist: which of them this install created. */
export const DIRECTORIES = `${STATE_DIR}/directories.json`;
/** Written last: its presence says that install finished. */
export const COMPLETE = `${STATE_DIR}/complete`;
export const PAYLOAD_COUNT = 20;

/** Packaged source (relative to the package) and destination relative to the host root. */
const COMMON: readonly (readonly [string, string])[] = [
  ["templates/lead/SKILL.md", "SKILL.md"],
  ["templates/lead/routing.md", "routing.md"],
  ["templates/lead/brief.md", "brief.md"],
  ["templates/lead/handoff.md", "handoff.md"],
  ["templates/lead/agents/reader.md", "agents/reader.md"],
  ["templates/lead/agents/mechanical.md", "agents/mechanical.md"],
  ["templates/lead/agents/builder.md", "agents/builder.md"],
  ["templates/lead/agents/verifier.md", "agents/verifier.md"],
  ["templates/lead/agents/advisor.md", "agents/advisor.md"],
  ["templates/workflows/crm-review.md", "workflows/crm-review.md"],
  ["templates/workflows/materials.md", "workflows/materials.md"],
  ["templates/workflows/call-review.md", "workflows/call-review.md"],
  ["templates/workflows/market-research.md", "workflows/market-research.md"],
  ["templates/workflows/company-knowledge.md", "workflows/company-knowledge.md"],
  ["templates/workflows/notes.md", "workflows/notes.md"],
  ["templates/workflows/memory.md", "workflows/memory.md"],
  ["templates/workflows/knowledge.md", "workflows/knowledge.md"],
  ["templates/workflows/learning.md", "workflows/learning.md"],
  ["templates/workflows/sample-customers.csv", "workflows/sample-customers.csv"],
];

/** Host root relative to the workspace, and the one bootstrap file at the workspace root. */
const HOST_LAYOUT: Readonly<Record<Host, { root: string; parents: readonly string[]; bootstrapSource: string; bootstrap: string }>> = {
  claude: { root: ".claude/skills/orch-lead", parents: [".claude", ".claude/skills"], bootstrapSource: "templates/lead/bootstrap-claude.md", bootstrap: "CLAUDE.md" },
  codex: { root: ".agents/skills/orch-lead", parents: [".agents", ".agents/skills"], bootstrapSource: "templates/lead/bootstrap-codex.md", bootstrap: "AGENTS.md" },
};

/** Order by Unicode code point (not by UTF-16 unit, not by locale). */
export function codePointCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export interface PayloadRow {
  /** Packaged file, relative to the package root, with `/`. */
  source: string;
  /** Destination relative to the workspace, with `/`. */
  dest: string;
  /** Anchor relative to the state directory: `objects/NN`. */
  anchor: string;
  /** True for the bootstrap file at the workspace root; it is published last. */
  bootstrap: boolean;
}

/** The 20 payload rows of a host, in code-point order of the destination, anchors numbered in that order. */
export function payloadRows(host: Host): PayloadRow[] {
  const layout = HOST_LAYOUT[host];
  const rows = COMMON.map(([source, rel]) => ({ source, dest: `${layout.root}/${rel}`, bootstrap: false }));
  rows.push({ source: layout.bootstrapSource, dest: layout.bootstrap, bootstrap: true });
  rows.sort((a, b) => codePointCompare(a.dest, b.dest));
  return rows.map((row, i) => ({ ...row, anchor: `objects/${String(i).padStart(2, "0")}` }));
}

/** Rows in publication order: the bootstrap file last. */
export function publicationOrder<T extends PayloadRow>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => !r.bootstrap), ...rows.filter((r) => r.bootstrap)];
}

/** Directories that may already exist (shared with the host), outermost first. */
export function sharedParents(host: Host): string[] {
  return [...HOST_LAYOUT[host].parents];
}

/** Directories install creates and that must not exist beforehand, outermost first. */
export function packDirs(host: Host): string[] {
  const root = HOST_LAYOUT[host].root;
  return [root, `${root}/agents`, `${root}/workflows`];
}

/** Every host-side directory install may create, outermost first: a parent always comes before what is inside it. */
export function hostDirs(host: Host): string[] {
  return [...sharedParents(host), ...packDirs(host)];
}

export function hostRoot(host: Host): string {
  return HOST_LAYOUT[host].root;
}

/** A manifest row path must be a plain relative path made of ordinary names. */
export function isLiteralRowPath(s: string): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 200) return false;
  const parts = s.split("/");
  return parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".." && !/[. ]$/.test(part) && !WINDOWS_RESERVED.test(part));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/**
 * Text-only check of a workspace path, before any file access. Returns why it is refused, or
 * null. `p` is the path flavour in use (node:path on this machine; tests also pass path.win32).
 */
export function refuseWorkspaceText(input: string, p: PlatformPath): string | null {
  if (typeof input !== "string" || input.length === 0) return "the path is empty";
  if (input.includes("\0")) return "the path contains a NUL character";
  if (p.sep !== "\\") return null;
  const s = input.replace(/\//g, "\\");
  if (s.startsWith("\\\\")) return "network (UNC) and device paths are not supported";
  const root = p.parse(s).root;
  if (/^[A-Za-z]:$/.test(root)) return "a drive letter without a backslash (C:folder) is ambiguous";
  if (root === "\\") return "a path that starts with a backslash has no drive letter";
  const rest = s.slice(root.length);
  if (rest.includes(":")) return "a colon after the drive letter is not supported";
  for (const part of rest.split("\\")) {
    if (part === "" || part === "." || part === "..") continue;
    if (/[. ]$/.test(part)) return "a folder name ends with a dot or a space";
    if (/[<>"|?*\x00-\x1f]/.test(part)) return "a folder name contains a character Windows does not allow";
    if (WINDOWS_RESERVED.test(part)) return "a folder name is reserved by Windows";
  }
  return null;
}

/**
 * Join a literal row path below the workspace and prove, with the path module alone, that the
 * result stays inside it. Throws on anything else; callers validate rows before calling.
 */
export function insideWorkspace(p: PlatformPath, workspace: string, rel: string): string {
  if (!isLiteralRowPath(rel)) throw new RangeError(`not a literal relative path: ${rel}`);
  const parts = rel.split("/");
  const full = p.resolve(workspace, ...parts);
  const back = p.relative(workspace, full);
  if (p.isAbsolute(back) || back !== parts.join(p.sep)) throw new RangeError(`path leaves the workspace: ${rel}`);
  return full;
}
