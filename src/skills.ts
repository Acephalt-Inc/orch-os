// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../skills/", import.meta.url));
const marker = ".orch-os-owner.json";
const namePattern = /^[a-z0-9][a-z0-9-]*$/;

export function shippedSkills(sourceDir = source): string[] {
  return readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export interface SkillsTargetOptions {
  scope?: "workspace" | "user";
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: Pick<NodeJS.ProcessEnv, "HOME" | "USERPROFILE">;
  home?: string;
}

export function skillsTarget(options: SkillsTargetOptions | boolean = {}): string {
  const o = typeof options === "boolean" ? { scope: options ? "user" as const : "workspace" as const } : options;
  const platform = o.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const env = o.env ?? process.env;
  const home = o.home ?? (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) ?? homedir();
  return paths.join(o.scope === "user" ? home : o.cwd ?? process.cwd(), ".claude", "skills");
}

function validateName(name: string, sourceDir = source): void {
  if (!namePattern.test(name) || !shippedSkills(sourceDir).includes(name)) throw new Error(`unknown skill: ${name}`);
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

function entries(path: string): string[] { return readdirSync(path).sort(); }
function isDirectory(path: string): boolean { return lstatSync(path).isDirectory(); }

/** A link anywhere in an installed skill is unsafe to inspect or replace. */
function hasLink(path: string): boolean {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return true;
  return st.isDirectory() && entries(path).some((name) => hasLink(join(path, name)));
}

/** Hash names, types, and bytes, including empty directories but excluding the ownership record. */
function digestTree(path: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string, relative: string): void => {
    for (const name of entries(dir)) {
      if (!relative && name === marker) continue;
      const child = join(dir, name);
      const st = lstatSync(child);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error(`${child} contains a symbolic link or special file`);
      const part = relative ? `${relative}/${name}` : name;
      hash.update(JSON.stringify([part, st.isDirectory() ? "dir" : "file"]));
      if (st.isDirectory()) visit(child, part);
      else { const bytes = readFileSync(child); hash.update(String(bytes.length)); hash.update(":"); hash.update(bytes); }
    }
  };
  visit(path, "");
  return hash.digest("hex");
}

function ownedDigest(path: string, name: string): string | null {
  if (!isDirectory(path)) return null;
  const record = join(path, marker);
  if (!exists(record) || !lstatSync(record).isFile()) return null;
  try {
    const data = JSON.parse(readFileSync(record, "utf8"));
    return data.schema === 1 && data.name === name && typeof data.digest === "string" && /^[a-f0-9]{64}$/.test(data.digest)
      ? data.digest : null;
  } catch { return null; }
}

function checkParent(path: string, create: boolean): void {
  for (const dir of [dirname(path), path]) {
    if (exists(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a regular directory`);
    } else if (create) mkdirSync(dir);
  }
}

export type SkillState = "installed" | "modified" | "missing";
export function skillState(name: string, target = skillsTarget(), sourceDir = source): SkillState {
  validateName(name, sourceDir);
  checkParent(target, false);
  const destination = join(target, name);
  if (!exists(destination)) return "missing";
  if (hasLink(destination)) return "modified";
  if (!isDirectory(destination)) return "modified";
  const recorded = ownedDigest(destination, name);
  return recorded && digestTree(destination) === recorded && digestTree(join(sourceDir, name)) === recorded ? "installed" : "modified";
}

export function skillRows(target = skillsTarget(), sourceDir = source): { name: string; state: SkillState }[] {
  return shippedSkills(sourceDir).map((name) => ({ name, state: skillState(name, target, sourceDir) }));
}

export type InstallAction = "installed" | "unchanged" | "kept (modified)" | "kept (unowned)" | "backed up and installed" | "would install" | "would keep (modified)" | "would keep (unowned)" | "would replace";
export interface InstallHooks { beforePublish?: () => void }
export function installSkill(name: string, target: string, force: boolean, dryRun: boolean, sourceDir = source, hooks: InstallHooks = {}): InstallAction {
  validateName(name, sourceDir);
  checkParent(target, false);
  const destination = join(target, name);
  const present = exists(destination);
  if (present && hasLink(destination)) throw new Error(`${destination} contains a symbolic link`);
  const recorded = present ? ownedDigest(destination, name) : null;
  const current = present && isDirectory(destination) ? digestTree(destination) : null;
  const sourceDigest = digestTree(join(sourceDir, name));
  const unowned = present && !recorded;
  const modified = present && (unowned || current !== recorded || current !== sourceDigest);
  if (present && !modified) return "unchanged";
  if (dryRun) return !present ? "would install" : !force ? unowned ? "would keep (unowned)" : "would keep (modified)" : "would replace";
  if (present && !force) return unowned ? "kept (unowned)" : "kept (modified)";
  checkParent(target, true);
  let backup: string | null = null;
  if (present) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    backup = mkdtempSync(join(target, `${name}.bak-${stamp}-`));
    renameSync(destination, join(backup, "original"));
  }
  try {
    hooks.beforePublish?.();
    mkdirSync(destination); // exclusive: a competing user directory must remain untouched
    cpSync(join(sourceDir, name), destination, { recursive: true, force: false, errorOnExist: true });
    if (digestTree(destination) !== sourceDigest) throw new Error("source changed during installation");
    writeFileSync(join(destination, marker), JSON.stringify({ schema: 1, name, digest: sourceDigest }) + "\n", { flag: "wx" });
  } catch (e: any) {
    // A partial destination may contain concurrent user files. Leave it and the backup in place.
    if (backup) throw new Error(`${e.message ?? e}; backup retained at ${backup}`);
    throw e;
  }
  return backup ? "backed up and installed" : "installed";
}

export type UninstallAction = "removed" | "missing" | "kept (modified)" | "kept (unowned)" | "would remove" | "would keep (modified)" | "would keep (unowned)";
export interface UninstallHooks { beforeQuarantine?: () => void }
export function uninstallSkill(name: string, target: string, dryRun: boolean, sourceDir = source, hooks: UninstallHooks = {}): UninstallAction {
  validateName(name, sourceDir);
  checkParent(target, false);
  const destination = join(target, name);
  if (!exists(destination)) return "missing";
  if (hasLink(destination)) throw new Error(`${destination} contains a symbolic link`);
  if (!isDirectory(destination)) return dryRun ? "would keep (unowned)" : "kept (unowned)";
  const recorded = ownedDigest(destination, name);
  if (!recorded) return dryRun ? "would keep (unowned)" : "kept (unowned)";
  if (digestTree(destination) !== recorded) return dryRun ? "would keep (modified)" : "kept (modified)";
  if (dryRun) return "would remove";
  hooks.beforeQuarantine?.();
  const quarantine = mkdtempSync(join(target, `.${name}.uninstall-`));
  const held = join(quarantine, "original");
  renameSync(destination, held);
  try {
    if (hasLink(held) || !isDirectory(held) || ownedDigest(held, name) !== recorded || digestTree(held) !== recorded) {
      throw new Error("skill changed before removal");
    }
  } catch (e: any) {
    throw new Error(`${e.message ?? e}; retained at ${quarantine}`);
  }
  rmSync(held, { recursive: true });
  rmdirSync(quarantine);
  return "removed";
}
