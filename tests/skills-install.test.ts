// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./_helpers.js";
import { installSkill, skillState, skillsTarget, uninstallSkill } from "../src/skills.js";

describe("skills install", () => {
  let workspace: string;
  let home: string;
  let oldHome: string | undefined;
  let oldUserProfile: string | undefined;
  let oldOrchHome: string | undefined;
  const original = process.cwd();
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "orch-skills-"));
    home = mkdtempSync(join(tmpdir(), "orch-skills-home-"));
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    oldOrchHome = process.env.ORCH_HOME;
    process.env.HOME = home;
    // On Windows the user scope is USERPROFILE (see "uses native path styles and Windows USERPROFILE").
    process.env.USERPROFILE = home;
    process.env.ORCH_HOME = join(home, "orch-state");
    process.chdir(workspace);
  });
  afterEach(() => {
    process.chdir(original);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
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
    expect(readFileSync(join(root, backup!, "original", "SKILL.md"), "utf8")).toBe("my local changes\n");
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
    expect(value.version).toBe("2.3.1");
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

  it("uninstall removes an owned unchanged skill and leaves its siblings", async () => {
    await run("skills", "install", "--only", "away,back");
    const [code, out] = await run("skills", "uninstall", "--only", "away");
    expect(code).toBe(0);
    expect(out).toContain("away: removed");
    expect(existsSync(join(workspace, ".claude", "skills", "away"))).toBe(false);
    expect(existsSync(join(workspace, ".claude", "skills", "back", "SKILL.md"))).toBe(true);
    // The uninstall quarantine folder must be gone too, not only the original destination.
    expect(readdirSync(join(workspace, ".claude", "skills")).sort()).toEqual(["back"]);
  });

  it("uninstall preserves edited, extra, and unowned matching files", async () => {
    const root = join(workspace, ".claude", "skills");
    await run("skills", "install", "--only", "away,back");
    writeFileSync(join(root, "away", "SKILL.md"), "local edit\n");
    writeFileSync(join(root, "back", "extra.txt"), "user file\n");
    cpSync(join(original, "skills", "record"), join(root, "record"), { recursive: true });
    const [code, out] = await run("skills", "uninstall", "--only", "away,back,record");
    expect(code).toBe(0);
    expect(out).toContain("away: kept (modified)");
    expect(out).toContain("back: kept (modified)");
    expect(out).toContain("record: kept (unowned)");
    for (const name of ["away", "back", "record"]) expect(existsSync(join(root, name))).toBe(true);
    expect(skillState("record", root)).toBe("modified");
  });

  it("does not claim a preexisting matching skill on install", async () => {
    const root = join(workspace, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    cpSync(join(original, "skills", "away"), join(root, "away"), { recursive: true });
    const [code, out] = await run("skills", "install", "--only", "away");
    expect(code).toBe(0);
    expect(out).toContain("away: kept (unowned)");
    expect(readdirSync(join(root, "away"))).toEqual(readdirSync(join(original, "skills", "away")));
    expect((await run("skills", "uninstall", "--only", "away"))[1]).toContain("away: kept (unowned)");
  });

  it("uninstall dry run writes nothing and rejects a damaged ownership record", async () => {
    await run("skills", "install", "--only", "away");
    const dir = join(workspace, ".claude", "skills", "away");
    const before = readdirSync(dir);
    const [code, out] = await run("skills", "uninstall", "--dry-run", "--only", "away");
    expect(code).toBe(0);
    expect(out).toContain("away: would remove");
    expect(readdirSync(dir)).toEqual(before);
    const marker = before.find((name) => name.startsWith(".orch-os"));
    expect(marker).toBeDefined();
    writeFileSync(join(dir, marker!), "{}");
    expect((await run("skills", "uninstall", "--only", "away"))[1]).toContain("away: kept (unowned)");
    expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("uninstall rejects links without touching their targets", async () => {
    await run("skills", "install", "--only", "away");
    const dir = join(workspace, ".claude", "skills", "away");
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "safe\n");
    symlinkSync(outside, join(dir, "link.txt"));
    const [code, , err] = await run("skills", "uninstall", "--only", "away");
    expect(code).toBe(1);
    expect(err).toContain("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("safe\n");
    expect(existsSync(dir)).toBe(true);
  });

  it("accepts explicit host and scope, and rejects a conflicting user alias", async () => {
    const [code] = await run("skills", "install", "--host", "claude", "--scope", "user", "--only", "away");
    expect(code).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "away"))).toBe(true);
    expect((await run("skills", "status", "--scope", "user", "--json"))[1]).toContain('"state":"installed"');
    expect((await run("skills", "uninstall", "--scope", "user", "--only", "away"))[1]).toContain("away: removed");
    const [badCode] = await run("skills", "install", "--user", "--scope", "workspace", "--only", "away");
    expect(badCode).toBe(2);
  });

  it("validates names at the public function boundary", () => {
    const root = join(workspace, ".claude", "skills");
    expect(() => installSkill("../away", root, false, true)).toThrow();
    expect(() => skillState("../away", root)).toThrow();
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });

  it("uses native path styles and Windows USERPROFILE for both scopes", () => {
    const env = { HOME: "/home/other", USERPROFILE: "C:\\Users\\Operator" };
    expect(skillsTarget({ scope: "workspace", platform: "win32", cwd: "C:\\Work\\Project", env })).toBe("C:\\Work\\Project\\.claude\\skills");
    expect(skillsTarget({ scope: "user", platform: "win32", cwd: "C:\\Work\\Project", env })).toBe("C:\\Users\\Operator\\.claude\\skills");
    expect(skillsTarget({ scope: "workspace", platform: "darwin", cwd: "/work/project", env })).toBe("/work/project/.claude/skills");
    expect(skillsTarget({ scope: "user", platform: "darwin", cwd: "/work/project", env })).toBe("/home/other/.claude/skills");
  });

  it.each(["workspace", "user"] as const)("round trips install, status, and uninstall in %s scope", async (scope) => {
    const root = join(scope === "user" ? home : workspace, ".claude", "skills");
    const flags = ["--host", "claude", "--scope", scope];
    expect((await run("skills", "uninstall", ...flags, "--only", "away", "--dry-run"))[1]).toContain("away: missing");
    expect(existsSync(root)).toBe(false);
    expect((await run("skills", "install", ...flags, "--only", "away", "--dry-run"))[1]).toContain("away: would install");
    expect(existsSync(root)).toBe(false);
    expect((await run("skills", "install", ...flags, "--only", "away"))[1]).toContain("away: installed");
    expect(JSON.parse((await run("skills", "status", ...flags, "--json"))[1]).skills.find((r: { name: string }) => r.name === "away").state).toBe("installed");
    expect((await run("skills", "uninstall", ...flags, "--only", "away", "--dry-run"))[1]).toContain("away: would remove");
    expect(existsSync(join(root, "away"))).toBe(true);
    expect((await run("skills", "uninstall", ...flags, "--only", "away"))[1]).toContain("away: removed");
    expect(existsSync(join(root, "away"))).toBe(false);
  });

  it("keeps force backups after uninstall", async () => {
    await run("skills", "install", "--only", "away");
    const root = join(workspace, ".claude", "skills");
    writeFileSync(join(root, "away", "SKILL.md"), "user edit\n");
    await run("skills", "install", "--only", "away", "--force");
    const backup = readdirSync(root).find((name) => name.startsWith("away.bak-"));
    expect(backup).toBeDefined();
    await run("skills", "uninstall", "--only", "away");
    expect(readFileSync(join(root, backup!, "original", "SKILL.md"), "utf8")).toBe("user edit\n");
  });

  it("uninstalls an unchanged old version using its recorded digest", () => {
    const fixture = join(workspace, "bundle");
    const target = join(workspace, ".claude", "skills");
    mkdirSync(join(fixture, "sample"), { recursive: true });
    writeFileSync(join(fixture, "sample", "SKILL.md"), "version one\n");
    expect(installSkill("sample", target, false, false, fixture)).toBe("installed");
    writeFileSync(join(fixture, "sample", "SKILL.md"), "version two\n");
    expect(skillState("sample", target, fixture)).toBe("modified");
    expect(uninstallSkill("sample", target, false, fixture)).toBe("removed");
  });

  it("rejects unsupported hosts and conflicting scope in every command", async () => {
    for (const command of ["install", "status", "uninstall"]) {
      expect((await run("skills", command, "--host", "other"))[0]).toBe(2);
      expect((await run("skills", command, "--user", "--scope", "workspace"))[0]).toBe(2);
    }
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });

  it("preserves a regular file at the skill destination unless force backs it up", async () => {
    const root = join(workspace, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "away"), "my file\n");
    expect((await run("skills", "status", "--json"))[1]).toContain('"name":"away","state":"modified"');
    expect((await run("skills", "install", "--only", "away"))[1]).toContain("away: kept (unowned)");
    expect((await run("skills", "uninstall", "--only", "away"))[1]).toContain("away: kept (unowned)");
    expect(readFileSync(join(root, "away"), "utf8")).toBe("my file\n");
    expect((await run("skills", "install", "--only", "away", "--force"))[1]).toContain("away: backed up and installed");
    const backup = readdirSync(root).find((name) => name.startsWith("away.bak-"));
    expect(readFileSync(join(root, backup!, "original"), "utf8")).toBe("my file\n");
  });

  it("refuses an empty user directory created just before first publication", () => {
    const root = join(workspace, ".claude", "skills");
    const dest = join(root, "away");
    expect(() => installSkill("away", root, false, false, undefined, { beforePublish: () => mkdirSync(dest) })).toThrow();
    expect(readdirSync(dest)).toEqual([]);
  });

  it("keeps the backup and a competing directory when forced publication races", () => {
    const root = join(workspace, ".claude", "skills");
    installSkill("away", root, false, false);
    const dest = join(root, "away");
    writeFileSync(join(dest, "SKILL.md"), "my edit\n");
    expect(() => installSkill("away", root, true, false, undefined, { beforePublish: () => {
      mkdirSync(dest);
      writeFileSync(join(dest, "mine.txt"), "competing file\n");
    } })).toThrow();
    expect(readFileSync(join(dest, "mine.txt"), "utf8")).toBe("competing file\n");
    const backup = readdirSync(root).find((name) => name.startsWith("away.bak-"));
    expect(readFileSync(join(root, backup!, "original", "SKILL.md"), "utf8")).toBe("my edit\n");
  });

  it("retains a newly added user file when uninstall races", () => {
    const root = join(workspace, ".claude", "skills");
    installSkill("away", root, false, false);
    expect(() => uninstallSkill("away", root, false, undefined, { beforeQuarantine: () => {
      writeFileSync(join(root, "away", "mine.txt"), "user data\n");
    } })).toThrow(/retained/);
    const quarantine = readdirSync(root).find((name) => name.startsWith(".away.uninstall-"));
    expect(readFileSync(join(root, quarantine!, "original", "mine.txt"), "utf8")).toBe("user data\n");
  });

  it("retains a substituted unowned directory when uninstall races", () => {
    const root = join(workspace, ".claude", "skills");
    installSkill("away", root, false, false);
    const moved = join(workspace, "moved-away");
    expect(() => uninstallSkill("away", root, false, undefined, { beforeQuarantine: () => {
      renameSync(join(root, "away"), moved);
      mkdirSync(join(root, "away"));
      writeFileSync(join(root, "away", "mine.txt"), "user data\n");
    } })).toThrow(/retained/);
    expect(existsSync(join(moved, "SKILL.md"))).toBe(true);
    const quarantine = readdirSync(root).find((name) => name.startsWith(".away.uninstall-"));
    expect(readFileSync(join(root, quarantine!, "original", "mine.txt"), "utf8")).toBe("user data\n");
  });
});
