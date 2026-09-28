// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Optional, user-selected Claude Code add-ons. No third-party content is bundled. */
import { spawnSync } from "node:child_process";
import { which } from "./util.js";

export interface Recommendation {
  name: string;
  url: string;
  license: string;
  value: string;
  commands: string[][];
}

export const RECOMMENDATIONS: Recommendation[] = [
  { name: "Claude official plugins", url: "https://github.com/anthropics/claude-plugins-official", license: "Apache-2.0", value: "Official plugin marketplace", commands: [["plugin", "marketplace", "add", "anthropics/claude-plugins-official"]] },
  { name: "Anthropic document skills", url: "https://github.com/anthropics/skills", license: "mixed; check each skill", value: "Official document skills", commands: [["plugin", "marketplace", "add", "anthropics/skills"], ["plugin", "install", "document-skills@anthropic-agent-skills"]] },
  { name: "Superpowers", url: "https://github.com/obra/superpowers", license: "MIT", value: "Structured development workflows", commands: [["plugin", "marketplace", "add", "obra/superpowers"], ["plugin", "install", "superpowers@superpowers-dev"]] },
  { name: "I Have ADHD", url: "https://github.com/ayghri/i-have-adhd", license: "MIT", value: "Task focus and continuity", commands: [["plugin", "marketplace", "add", "ayghri/i-have-adhd"], ["plugin", "install", "i-have-adhd@i-have-adhd"]] },
  { name: "Caveman", url: "https://github.com/JuliusBrussee/caveman", license: "non-standard, read before use", value: "Plain-language software planning", commands: [["plugin", "marketplace", "add", "JuliusBrussee/caveman"], ["plugin", "install", "caveman@caveman"]] },
];

export type Runner = (bin: string, args: string[]) => number;
const defaultRunner: Runner = (bin, args) => {
  const result = spawnSync(bin, args, { stdio: "inherit" });
  return result.status ?? 1;
};

/** Always print first. No CLI means commands are instructions only; failures do not stop later items. */
export function runRecommendations(selected: number[], out: (line: string) => void,
                                   cli = which("claude"), run: Runner = defaultRunner): void {
  for (const index of selected) {
    const item = RECOMMENDATIONS[index];
    if (!item) continue;
    out(`${item.name}: ${item.url} (license: ${item.license})`);
    for (const args of item.commands) {
      out(`claude ${args.join(" ")}`);
      if (!cli) continue;
      try {
        if (run(cli, args) !== 0) out(`  command failed; continuing`);
      } catch (e) {
        out(`  command failed; continuing (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  if (selected.length && !cli) out("Claude CLI not found; commands were printed but not run.");
}
