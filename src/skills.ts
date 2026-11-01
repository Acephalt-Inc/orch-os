// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../skills/", import.meta.url));

export function shippedSkills(): string[] {
  return readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export function skillsTarget(user = false): string {
  return join(user ? (process.env.HOME || process.env.USERPROFILE || homedir()) : process.cwd(), ".claude", "skills");
}

function entries(path: string): string[] {
  return readdirSync(path).sort();
}

/** A link anywhere in an installed skill is unsafe to inspect or replace. */
function hasLink(path: string): boolean {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return true;
  return st.isDirectory() && entries(path).some((name) => hasLink(join(path, name)));
}

function equalTree(left: string, right: string): boolean {
  const a = lstatSync(left);
  const b = lstatSync(right);
  if (a.isSymbolicLink() || b.isSymbolicLink()) return false;
  if (a.isDirectory() !== b.isDirectory() || a.isFile() !== b.isFile()) return false;
  if (a.isFile()) return readFileSync(left).equals(readFileSync(right));
  if (!a.isDirectory()) return false;
  const names = entries(left);
  const other = entries(right);
  return names.length === other.length && names.every((name, i) => name === other[i] && equalTree(join(left, name), join(right, name)));
}

function checkParent(path: string, create: boolean): void {
  for (const dir of [dirname(path), path]) {
    if (lstatMaybe(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a regular directory`);
    } else if (create) mkdirSync(dir);
  }
}

function lstatMaybe(path: string): boolean {
  try { lstatSync(path); return true; } catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

export type SkillState = "installed" | "modified" | "missing";
export function skillState(name: string, target = skillsTarget()): SkillState {
  checkParent(target, false);
  const destination = join(target, name);
  if (!lstatMaybe(destination)) return "missing";
  if (hasLink(destination)) return "modified";
  return equalTree(join(source, name), destination) ? "installed" : "modified";
}

export function skillRows(target = skillsTarget()): { name: string; state: SkillState }[] {
  return shippedSkills().map((name) => ({ name, state: skillState(name, target) }));
}

export type InstallAction = "installed" | "unchanged" | "kept (modified)" | "backed up and installed" | "would install" | "would keep (modified)" | "would replace";
export function installSkill(name: string, target: string, force: boolean, dryRun: boolean): InstallAction {
  checkParent(target, false);
  const destination = join(target, name);
  if (lstatMaybe(destination) && hasLink(destination)) throw new Error(`${destination} contains a symbolic link`);
  const state = skillState(name, target);
  if (state === "installed") return "unchanged";
  if (dryRun) return state === "missing" ? "would install" : force ? "would replace" : "would keep (modified)";
  if (state === "modified" && !force) return "kept (modified)";
  checkParent(target, true);
  const temp = mkdtempSync(join(target, `.${name}.tmp-`));
  try {
    cpSync(join(source, name), temp, { recursive: true, force: true });
    if (state === "modified") {
      const stamp = new Date().toISOString().replace(/[-:.]/g, "");
      let backup = join(target, `${name}.bak-${stamp}`);
      for (let i = 1; lstatMaybe(backup); i++) backup = join(target, `${name}.bak-${stamp}-${i}`);
      renameSync(destination, backup);
      try { renameSync(temp, destination); }
      catch (e) { renameSync(backup, destination); throw e; }
      return "backed up and installed";
    }
    renameSync(temp, destination);
    return "installed";
  } finally {
    if (lstatMaybe(temp)) rmSync(temp, { recursive: true, force: true });
  }
}
