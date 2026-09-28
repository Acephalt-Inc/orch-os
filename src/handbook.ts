// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The role boot files and the handbook that `orch init` writes (new in v2).
 *
 * layout "flat"   => <dir>/lead-boot.md, worker-boot.md, review-boot.md, protocols.md
 * layout "skills" => <dir>/<name>/SKILL.md, the folder-per-skill layout agent CLIs load skills from
 * Every file starts with a name/description frontmatter block, so the same text works as a
 * skill, or as a plain file an instructions file (AGENTS.md, CLAUDE.md, ...) points to.
 * Existing files are kept unless force is set: they are yours to edit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TEMPLATE_DIR = fileURLToPath(new URL("../templates/handbook/", import.meta.url));
export const HANDBOOK = ["lead-boot", "worker-boot", "review-boot", "protocols"];
export type Layout = "flat" | "skills";

export function targetFile(dir: string, name: string, layout: Layout): string {
  return layout === "skills" ? `${dir}/${name}/SKILL.md` : `${dir}/${name}.md`;
}

export function writeHandbook(dir: string, layout: Layout = "flat", force = false): { file: string; action: "wrote" | "kept" }[] {
  return HANDBOOK.map((name) => {
    const file = targetFile(dir, name, layout);
    if (existsSync(file) && !force) return { file, action: "kept" as const };
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, readFileSync(`${TEMPLATE_DIR}${name}.md`, "utf8"));
    return { file, action: "wrote" as const };
  });
}
