// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Validate command paths and flags against the public CLI help, without running a command.
import { spawnSync } from "node:child_process";
import { DIST_CLI } from "./_helpers.js";

export function commandErrors(text: string): string[] {
  const mentions = [...text.matchAll(/\borch\s+[a-z][\w-]*(?:[^`\n]*)/g)].map((m) => m[0].split(/\s+#/)[0].trim());
  return mentions.flatMap((mention) => {
    const tokens = mention.split(/\s+/).slice(1);
    const path: string[] = [];
    let help = "";
    for (;;) {
      const result = spawnSync(process.execPath, [DIST_CLI, ...path, "--help"], { encoding: "utf8", timeout: 10_000 });
      if (result.status !== 0) return [`${mention}: help failed at ${path.join(" ")}`];
      help = result.stdout;
      if (!/^commands:$/m.test(help)) break;
      const next = tokens.shift();
      if (!next || !new RegExp(`^  ${next.replace(/[^\w-]/g, "")}\\s`, "m").test(help)) return [`${mention}: unknown command ${next ?? "(missing)"}`];
      path.push(next);
    }
    const flags = tokens.filter((t) => /^--?[a-z]/.test(t)).map((t) => t.match(/^--?[\w-]+/)![0]);
    return flags.filter((flag) => !new RegExp(`(?:^|[ ,\\[])${flag}(?=[ ,\\]=]|$)`, "m").test(help)).map((flag) => `${mention}: unknown option ${flag}`);
  });
}
