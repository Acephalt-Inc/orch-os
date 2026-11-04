// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildTree } from "../src/cli.js";
import { installSkill, shippedSkills } from "../src/skills.js";

let workspace: string | undefined;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

it("every installed skill has discoverable metadata and references real CLI commands", () => {
  workspace = mkdtempSync(join(tmpdir(), "orch-skill-content-"));
  const target = join(workspace, ".claude", "skills");
  const names = shippedSkills();
  expect(names).toEqual(expect.arrayContaining(["daily-brief", "decision-inbox", "ops-followup"]));
  expect(names).toHaveLength(16);
  const commands = buildTree().sub!;
  let references = 0;
  for (const name of names) {
    expect(installSkill(name, target, false, false), name).toBe("installed");
    const content = readFileSync(join(target, name, "SKILL.md"), "utf8");
    const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    expect(metadata, `${name}: YAML frontmatter`).toBeDefined();
    expect(metadata, `${name}: name`).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(metadata, `${name}: description`).toMatch(/^description: \S.+$/m);
    for (const match of content.matchAll(/\borch[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g)) {
      references++;
      const command = commands.find((candidate) => candidate.name === match[1]);
      expect(command, `${name}: ${match[0]}`).toBeDefined();
      if (command?.sub && match[2]) {
        expect(command.sub.map((child) => child.name), `${name}: ${match[0]}`).toContain(match[2]);
      }
    }
  }
  expect(references).toBeGreaterThan(0);
  expect(readdirSync(target).sort()).toEqual(names);
});
