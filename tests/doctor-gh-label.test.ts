// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { which } from "../src/util.js";
import { DIST_CLI, ROOT, testPath, tmp, useTmpHome } from "./_helpers.js";

describe("DoctorGhLabel", () => {
  const ctx = useTmpHome();
  let bins = "";

  beforeEach(() => {
    bins = tmp("orch-gh-label-");
  });

  afterEach(() => {
    rmSync(bins, { recursive: true, force: true });
  });

  it("names_gh_for_all_live_github_commands", () => {
    // The row is read with gh absent. Some machines keep gh beside git in /usr/bin, so on macOS and
    // Linux PATH is one folder that holds a link to git and nothing else.
    const posix = process.platform !== "win32";
    if (posix) symlinkSync(which("git")!, join(bins, "git"));
    const env = { ...process.env, ORCH_HOME: ctx.home, PATH: posix ? bins : testPath(bins), ORCH_AGENT_DIRS: "" };
    const init = spawnSync(process.execPath, [DIST_CLI, "init", "--no-profile", "--no-handbook"], { env, encoding: "utf8" });
    expect(init.status, `init stderr\n${init.stderr}`).toBe(0);
    const doctor = spawnSync(process.execPath, [DIST_CLI, "doctor"], { env, encoding: "utf8" });
    expect(doctor.status, `doctor stderr\n${doctor.stderr}`).toBe(0);
    const row = doctor.stdout.split("\n").find((line) => line.includes("gh ("));
    expect(row, "doctor gh row").toMatch(/^SKIP  gh \(live GitHub commands\)\s{2,}absent - fixtures still work$/);
    expect(row, "doctor gh row does not name one command").not.toMatch(/merge-gate|review|watch/);

    // These independent gh resolvers keep the witness broader than merge-gate.
    const mergeGate = readFileSync(`${ROOT}/src/mergegate.ts`, "utf8");
    const reviewWatch = readFileSync(`${ROOT}/src/reviewwatch.ts`, "utf8");
    expect(mergeGate).toContain('which("gh")');
    expect(mergeGate).toContain('gh(["pr", "comment"');
    expect(reviewWatch).toContain('which("gh")');
  });
});
