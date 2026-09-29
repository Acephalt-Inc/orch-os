// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** install.sh into a throwaway HOME: from a checkout, piped (gh path, stubbed), and ORCH_OS_REPO. */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { which } from "../src/util.js";
import { ROOT, tmp } from "./_helpers.js";

const HAVE = Boolean(which("git") && which("sh"));
const SKIP = new Set(["node_modules", ".git", "coverage"]);

describe.skipIf(!HAVE)("InstallTest", () => {
  let td = "";
  let home = "";
  let stub = "";
  let repo = "";

  beforeEach(() => {
    td = tmp("orch-inst-");
    home = join(td, "home");
    stub = join(td, "stubbin");
    repo = join(td, "repo");
    mkdirSync(home);
    mkdirSync(stub);
    // a clean copy of the working tree (with the built dist/) as a git repo, so clone paths
    // see uncommitted edits too and never need to build
    cpSync(ROOT, repo, { recursive: true, filter: (src) => !SKIP.has(basename(src)) && !src.endsWith(".tgz") });
    const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
    g("init", "-q");
    g("add", "-A");
    g("add", "-f", "dist");
    expect(g("commit", "-qm", "snapshot").status).toBe(0);
  });

  afterEach(() => rmSync(td, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    PATH: `${stub}:${home}/.local/bin:/usr/bin:/bin:${dirname(which("git")!)}:${dirname(realpathSync(process.execPath))}`,
    ORCH_NODE: process.execPath,
    ORCH_AGENT_DIRS: "",
    ...extra,
  });
  const runSh = (cmd: string, cwd: string, extra: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", cmd], { cwd, env: env(extra), encoding: "utf8", timeout: 120_000 });

  it("keeps the bundled capability validator out of runtime npm dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies.ajv).toBe("8.20.0");
  });

  function assertInstalledAndGreen(r: ReturnType<typeof runSh>) {
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const orch = join(home, ".local/bin/orch");
    expect(existsSync(orch)).toBe(true);
    let d = spawnSync(orch, ["init"], { env: env(), encoding: "utf8" });
    expect(d.status, d.stdout + d.stderr).toBe(0);
    d = spawnSync(orch, ["doctor"], { env: env(), encoding: "utf8" });
    expect(d.status, d.stdout + d.stderr).toBe(0);
    expect(d.stdout).toContain("doctor: PASS");
    d = spawnSync(orch, ["cap", "list"], { env: env(), encoding: "utf8" });
    expect(d.status, d.stdout + d.stderr).toBe(0);
    expect(d.stdout).toBe("providers: none\n");
    expect(existsSync(join(home, ".orch/lib/orch-os/schemas/cap-manifest-v1.schema.json"))).toBe(true);
    expect(existsSync(join(home, ".orch/lib/orch-os/THIRD_PARTY_NOTICES.md"))).toBe(true);
    expect(existsSync(join(home, ".orch/lib/orch-os/node_modules"))).toBe(false);
  }

  it("test_from_checkout", () => {
    const r = runSh("sh install.sh", repo);
    expect(r.stdout).toContain(`source: ${realpathSync(repo)}`);
    assertInstalledAndGreen(r);
  });

  it("test_piped_with_explicit_repo", () => {
    const r = runSh(`sh < '${repo}/install.sh'`, home, { ORCH_OS_REPO: repo });
    expect(r.stdout).toContain("fetching: git clone");
    assertInstalledAndGreen(r);
  });

  it("test_explicit_repo_beats_a_checkout_in_the_cwd", () => {
    const decoy = join(td, "decoy");
    mkdirSync(join(decoy, "src"), { recursive: true });
    writeFileSync(join(decoy, "package.json"), "{}");
    writeFileSync(join(decoy, "src/cli.ts"), "");
    const r = runSh(`sh < '${repo}/install.sh'`, decoy, { ORCH_OS_REPO: repo });
    expect(r.stdout).toContain("fetching: git clone");
    assertInstalledAndGreen(r);
  });

  it("test_piped_via_gh_when_logged_in", () => {
    // stub gh: `auth status` succeeds; `repo clone OWNER/NAME DIR -- ARGS` clones the local snapshot
    writeFileSync(join(stub, "gh"), "#!/bin/sh\n" +
      'case "$1 $2" in\n' +
      '  "auth status") exit 0 ;;\n' +
      `  "repo clone") dir="$4"; shift 5; exec git clone "$@" "file://${repo}" "$dir" ;;\n` +
      "esac\nexit 9\n");
    chmodSync(join(stub, "gh"), 0o755);
    const r = runSh(`sh < '${repo}/install.sh'`, home, { ORCH_INIT: "1", ORCH_OS_GH_REPO: "example-owner/ORCH-os" });
    expect(r.stdout).toContain("fetching: gh repo clone example-owner/ORCH-os");
    expect(r.stdout).toContain("doctor: PASS");
    assertInstalledAndGreen(r);
  });

  it("test_private_repo_without_gh_login_fails_with_a_hint", () => {
    writeFileSync(join(stub, "gh"), "#!/bin/sh\nexit 1\n"); // installed but not logged in
    chmodSync(join(stub, "gh"), 0o755);
    const r = runSh(`sh < '${repo}/install.sh'`, home, { ORCH_OS_GH_REPO: "invalid-owner-for-test/does-not-exist" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("gh auth login");
  });

  it("test_no_source_is_a_clear_error", () => {
    const r = runSh(`sh < '${repo}/install.sh'`, home);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("no source");
  });

  it("rejects Node 20 before copying or building an install", () => {
    const fakeNode = join(stub, "node");
    writeFileSync(fakeNode, '#!/bin/sh\ncase "$1" in\n  -e) case "$2" in *">= 22"*) exit 1;; *">= 20"*) exit 0;; esac;;\n  -p) printf "20.19.0\\n"; exit 0;;\nesac\nexit 9\n');
    chmodSync(fakeNode, 0o755);
    const r = runSh("sh install.sh", repo, { ORCH_NODE: fakeNode });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("need Node.js >= 22");
    expect(existsSync(join(home, ".orch/lib/orch-os"))).toBe(false);
  });

  it("test_rerun_keeps_config", () => {
    assertInstalledAndGreen(runSh("sh install.sh", repo));
    const cfg = join(home, ".orch/config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("my-team", "kept"));
    expect(runSh("sh install.sh", repo).status).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain("kept");
  });
});
