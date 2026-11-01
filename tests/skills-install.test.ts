// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./_helpers.js";

describe("skills install", () => {
  let workspace: string;
  let home: string;
  let oldHome: string | undefined;
  let oldOrchHome: string | undefined;
  const original = process.cwd();
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "orch-skills-"));
    home = mkdtempSync(join(tmpdir(), "orch-skills-home-"));
    oldHome = process.env.HOME;
    oldOrchHome = process.env.ORCH_HOME;
    process.env.HOME = home;
    process.env.ORCH_HOME = join(home, "orch-state");
    process.chdir(workspace);
  });
  afterEach(() => {
    process.chdir(original);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldOrchHome === undefined) delete process.env.ORCH_HOME;
    else process.env.ORCH_HOME = oldOrchHome;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("test_skills_install_copies_every_shipped_skill", async () => {
    const [code] = await run("skills", "install");
    expect(code).toBe(0);
    const shipped = readdirSync(join(original, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const installed = readdirSync(join(workspace, ".claude", "skills")).sort();
    expect(installed).toEqual(shipped);
    for (const name of shipped) expect(existsSync(join(workspace, ".claude", "skills", name, "SKILL.md"))).toBe(true);
  });

  it("test_skills_install_keeps_modified_copy", async () => {
    expect((await run("skills", "install", "--only", "away"))[0]).toBe(0);
    const path = join(workspace, ".claude", "skills", "away", "SKILL.md");
    writeFileSync(path, "my local changes\n");
    const [code, out] = await run("skills", "install", "--only", "away");
    expect(code).toBe(0);
    expect(out).toContain("away: kept (modified)");
    expect(readFileSync(path, "utf8")).toBe("my local changes\n");
  });

  it("test_skills_install_force_writes_backup_first", async () => {
    await run("skills", "install", "--only", "away");
    const root = join(workspace, ".claude", "skills");
    const path = join(root, "away", "SKILL.md");
    writeFileSync(path, "my local changes\n");
    const [code, out] = await run("skills", "install", "--only", "away", "--force");
    expect(code).toBe(0);
    expect(out).toContain("away: backed up and installed");
    const backup = readdirSync(root).find((name) => /^away\.bak-\d{8}T\d{9}Z/.test(name));
    expect(backup).toBeDefined();
    expect(readFileSync(join(root, backup!, "SKILL.md"), "utf8")).toBe("my local changes\n");
    expect(readFileSync(path, "utf8")).toBe(readFileSync(join(original, "skills", "away", "SKILL.md"), "utf8"));
  });

  it.skipIf(process.platform === "win32")("test_skills_install_refuses_symlinked_target", async () => {
    await run("skills", "install", "--only", "away");
    const root = join(workspace, ".claude", "skills");
    const outside = join(home, "untouched.md");
    writeFileSync(outside, "safe\n");
    rmSync(join(root, "away", "SKILL.md"));
    symlinkSync(outside, join(root, "away", "SKILL.md"));
    const [code, out, err] = await run("skills", "install", "--only", "away,back", "--force");
    expect(code).toBe(1);
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("away:");
    expect(out).toContain("back: installed");
    expect(readFileSync(outside, "utf8")).toBe("safe\n");
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked skill folder", async () => {
    const root = join(workspace, ".claude", "skills");
    await run("skills", "install", "--only", "back");
    symlinkSync(join(home, "outside"), join(root, "away"));
    const [code, out, err] = await run("skills", "install", "--only", "away,record");
    expect(code).toBe(1);
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("record: installed");
  });

  it("test_skills_status_lists_each_skill_once", async () => {
    await run("skills", "install", "--only", "away");
    const [code, out] = await run("skills", "status", "--json");
    expect(code).toBe(0);
    const value = JSON.parse(out);
    const shipped = readdirSync(join(original, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(value.version).toBe("2.2.0");
    expect(value.skills.map((row: { name: string }) => row.name)).toEqual(shipped);
    expect(value.skills.find((row: { name: string }) => row.name === "away").state).toBe("installed");
    expect(value.skills.find((row: { name: string }) => row.name === "back").state).toBe("missing");
    writeFileSync(join(workspace, ".claude", "skills", "away", "SKILL.md"), "changed\n");
    const changed = JSON.parse((await run("skills", "status", "--json"))[1]);
    expect(changed.skills.find((row: { name: string }) => row.name === "away").state).toBe("modified");
  });

  it("test_skills_install_user_flag_targets_home_only", async () => {
    const [code, , err] = await run("skills", "install", "--user", "--only", "away");
    expect(code, err).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "away", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });

  it("everyday init installs only with the explicit flag", async () => {
    const [code, out] = await run("init", "--no-profile", "--no-handbook", "--everyday", "--with-skills");
    expect(code).toBe(0);
    expect(out).toContain("orch skills install");
    expect(existsSync(join(workspace, ".claude", "skills", "away", "SKILL.md"))).toBe(true);
  });

  it("dry run reports actions without creating a target", async () => {
    const [code, out] = await run("skills", "install", "--dry-run", "--only", "away");
    expect(code).toBe(0);
    expect(out).toContain("away: would install");
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });
});
