// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DIST_CLI, ROOT } from "./_helpers.js";
import { commandErrors } from "./_lead-command-help.js";
import { payloadRows } from "../src/lead/paths.js";

describe("lead boot guide", () => {
  it("installs the guide for both hosts and links to it from the entry points", () => {
    for (const host of ["claude", "codex"] as const) {
      const row = payloadRows(host).find((r) => r.source === "templates/handbook/lead-boot.md" && r.dest.endsWith("/boot.md"));
      expect(row).toBeDefined();
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-boot-")));
      try {
        const result = spawnSync(process.execPath, [DIST_CLI, "lead", "install", "--workspace", dir, "--host", host], { encoding: "utf8", timeout: 20_000 });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(join(dir, ...row!.dest.split("/")), "utf8")).toBe(readFileSync(join(ROOT, row!.source), "utf8"));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    for (const file of ["templates/lead/SKILL.md", "templates/lead/bootstrap-claude.md"]) {
      expect(readFileSync(join(ROOT, file), "utf8")).toContain("boot.md");
    }
  });
  it("states the wake, verification, bounded tick and away policies", () => {
    const text = readFileSync(join(ROOT, "templates/handbook/lead-boot.md"), "utf8");
    for (const pattern of [/Monitor/, /ORCH_HOME\/wake\/events\.log/, /orch msg watch --as lead/, /CronCreate/, /CronList/, /CronDelete/, /\/loop 5m/, /orch-lead:<canonical-workspace>:<logical-session>:sentinel/, /readback evidence/i, /UNVERIFIED/, /UNAVAILABLE/, /expir/i, /renewal deadline at least two approved\s+intervals before expiry/i, /at\s+most 100 events/i, /at most one dispatch attempt/i, /human says they are leaving/i, /explicit return/i, /cancel this task.s sentinel and watcher/i]) {
      expect(text, `missing policy ${pattern}`).toMatch(pattern);
    }
  });
  it("validates documented commands at their CLI help depth", () => {
    const texts = ["templates/handbook/lead-boot.md", "templates/lead/SKILL.md", "templates/lead/bootstrap-claude.md"].map((f) => readFileSync(join(ROOT, f), "utf8"));
    expect(texts.join("\n")).toMatch(/\borch\s+/);
    expect(texts.flatMap(commandErrors)).toEqual([]);
    expect(commandErrors("`orch msg invented --as lead`").length).toBeGreaterThan(0);
    expect(commandErrors("`orch msg watch --invented`").length).toBeGreaterThan(0);
  });
});
