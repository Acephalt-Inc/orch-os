// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The doctor's Node row and agent-CLI row, and the install entry: one sentence in each README that
// leads to one guide file inside the package.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as C from "../src/config.js";
import * as D from "../src/detect.js";
import { parseToml } from "../src/toml.js";
import { DIST_CLI, fakeBin, keepEnv, ROOT, run, testPath, tmp, useTmpHome, WINDOWS } from "./_helpers.js";
import { candidate, npmCommand, pack } from "./_pack.js";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const GUIDE = "docs/INSTALL-WITH-AGENT.md";
const REPOSITORY = String(pkg.homepage).replace(/#.*$/, "");
/** The whole-number floor in `engines.node`, e.g. 22 for ">=22". */
const FLOOR = Number(/^>=(\d+)$/.exec(pkg.engines.node)?.[1]);
const KNOWN = D.KNOWN.map((k) => k[0]).join(", ");
const AGENT_HINT = `none found (this run looked for ${KNOWN}; \`orch agents\` lists each as found or absent)`;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** A path with `/` only: Windows prints some paths with either separator. */
const slash = (p: string) => p.replace(/\\/g, "/");

/** [status, name, detail] of every doctor row. */
function rowsOf(out: string): [string, string, string][] {
  return out.split("\n").filter((l) => /^(PASS|FAIL|SKIP) {2}/.test(l)).map((l) => {
    const [name, ...detail] = l.slice(6).split(/\s{2,}/);
    return [l.slice(0, 4), name.trim(), detail.join("  ")];
  });
}

/**
 * Run `f` while `process.versions.node` reads `version`. This is a controlled value handed to the
 * real doctor code; it is not a run on that Node.js release.
 */
async function withNodeVersion<T>(version: string, f: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "versions")!;
  Object.defineProperty(process, "versions", { ...real, value: { ...process.versions, node: version } });
  try {
    return await f();
  } finally {
    Object.defineProperty(process, "versions", real);
  }
}

/** A fresh home, PATH without any agent CLI, and no fallback directories. */
function useNoAgents() {
  const ctx = useTmpHome();
  const d = { bins: "", get home() { return ctx.home; } };
  keepEnv(["PATH", "ORCH_AGENT_DIRS"]);
  beforeEach(() => {
    d.bins = tmp("orch-ie-bins-");
    process.env.PATH = testPath(d.bins);
    process.env.ORCH_AGENT_DIRS = "";
  });
  afterEach(() => rmSync(d.bins, { recursive: true, force: true }));
  return d;
}

/** Run the compiled CLI under the operation observer. */
function observed(home: string, ...argv: string[]) {
  const r = spawnSync(process.execPath, [join(ROOT, "tests", "_observe-entry.mjs"), DIST_CLI, ...argv], {
    env: { ...process.env, ORCH_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 30_000,
  });
  expect(r.error, "observer child: spawn error").toBeUndefined();
  expect(r.signal, `observer child: signal\n${r.stderr}`).toBeNull();
  expect(r.stderr, "observer child: stderr").toBe("");
  const report = JSON.parse(String(r.output[3]));
  expect(report.failure, "observer child: main() threw").toBeNull();
  expect(report.code, "observer child: main() returned the exit code").toBe(r.status);
  return { status: r.status, stdout: r.stdout, ops: report.ops as { kind: string; op: string; path: string }[] };
}

describe("DoctorNodeFloor", () => {
  const d = useNoAgents();

  it("doctor_node_row_is_named_after_the_package_engines_floor", async () => {
    expect(FLOOR, "package.json engines.node is a plain >=N floor").toBeGreaterThan(0);
    const [, out] = await run("doctor");
    expect(rowsOf(out)[0][1], "doctor node row name").toBe(`node${pkg.engines.node}`);
  });

  it("doctor_node_row_fails_below_the_engines_floor_and_passes_from_it", async () => {
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    for (const version of [`${FLOOR - 2}.19.0`, `${FLOOR - 1}.99.99`]) {
      const [code, out] = await withNodeVersion(version, () => run("doctor"));
      const row = rowsOf(out)[0];
      expect(row[2], `node version fixture ${version}: detail`).toBe(version);
      expect(row[0], `node version fixture ${version}: row status`).toBe("FAIL");
      expect(out, `node version fixture ${version}: summary`).toContain("doctor: FAIL (1 required check(s) failed)");
      expect(code, `node version fixture ${version}: exit code`).toBe(1);
    }
    for (const version of [`${FLOOR}.0.0`, `${FLOOR + 2}.1.0`]) {
      const [code, out] = await withNodeVersion(version, () => run("doctor"));
      expect(rowsOf(out)[0][0], `node version fixture ${version}: row status`).toBe("PASS");
      expect(code, `node version fixture ${version}: exit code\n${out}`).toBe(0);
    }
  });

  it("doctor_in_a_real_process_reports_the_running_node_version", () => {
    const r = spawnSync(process.execPath, [DIST_CLI, "doctor"], { env: { ...process.env, ORCH_HOME: d.home }, encoding: "utf8", timeout: 30_000 });
    expect(r.error, "doctor child: spawn error").toBeUndefined();
    expect(r.stderr, "doctor child: stderr").toBe("");
    const running = Number(process.versions.node.split(".")[0]);
    expect(rowsOf(r.stdout)[0], "doctor child: node row").toEqual([running >= FLOOR ? "PASS" : "FAIL", `node>=${FLOOR}`, process.versions.node]);
  });
});

describe("DoctorAgentRow", () => {
  const d = useNoAgents();
  const agentRow = async () => rowsOf((await run("doctor"))[1]).find((r) => r[1] === "agent CLIs")!;

  it("doctor_agent_row_points_at_no_command_that_rewrites_files", async () => {
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    const [status, , detail] = await agentRow();
    expect(status, "agent CLIs row status with no agent CLI").toBe("SKIP");
    expect(detail, "agent CLIs row text with no agent CLI").toBe(AGENT_HINT);
    expect([...detail.matchAll(/`(orch [^`]*)`/g)].map((m) => m[1]), "orch commands the agent CLIs row names").toEqual(["orch agents"]);
    expect(/\binit\b|--force/.test(detail), "agent CLIs row names init or --force").toBe(false);
  });

  // How the row is computed: detected on each run from PATH (and the agent search directories), never read from config.toml.
  it("doctor_agent_row_follows_the_cli_found_by_this_run_not_config", async () => {
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    const config = readFileSync(join(d.home, "config.toml"), "utf8");
    expect(Object.keys(parseToml(config)).includes("agents"), "config.toml written with no agent CLI has an [agents.*] table").toBe(false);
    fakeBin(d.bins, "codex");
    expect(await agentRow(), "agent CLIs row after a CLI appears on PATH").toEqual(["PASS", "agent CLIs", "codex"]);
    expect(readFileSync(join(d.home, "config.toml"), "utf8"), "config.toml after doctor").toBe(config);
  });

  it("orch_agents_changes_no_file_and_starts_no_process", async () => {
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    const r = observed(d.home, "agents");
    expect(r.status, `orch agents exit code\n${r.stdout}`).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l).map((l) => l.split(/\s+/)[0]), "orch agents lists every known CLI").toEqual(D.KNOWN.map((k) => k[0]));
    expect(r.stdout, "orch agents marks an absent CLI").toContain("absent");
    expect(r.ops, "file changes and process starts during orch agents").toEqual([]);
  });
});

// ---- the install entry ------------------------------------------------------------------------

function section(md: string, title: string): string {
  const heads = [...md.matchAll(/^## (.+)$/gm)];
  const i = heads.findIndex((m) => m[1] === title);
  if (i < 0) return "";
  return md.slice(heads[i].index! + heads[i][0].length, heads[i + 1]?.index);
}

/** The numbered steps of one guide group: the command in backticks that starts each step, and the rest of the line. */
function steps(group: string): { command: string; text: string }[] {
  return [...group.matchAll(/^\d+\. `([^`]+)`(.*)$/gm)].map((m) => ({ command: m[1], text: m[2] }));
}

const STEP_KINDS: Record<"macOS" | "Windows 11", [string, RegExp][]> = {
  macOS: [
    ["node", /^node --version$/],
    ["installed", /^ls -d "\$\(npm root --global\)\/orch-os"$/],
    ["on-path", /^command -v orch$/],
    ["home", /^ls -d "\$\{ORCH_HOME:-\$HOME\/\.orch\}"$/],
    ["install", /^npm install --global orch-os@\S+$/],
    ["init", /^orch init --no-profile --no-handbook$/],
    ["version", /^orch --version$/],
    ["doctor", /^orch doctor$/],
  ],
  "Windows 11": [
    ["node", /^node --version$/],
    ["installed", /^Test-Path -LiteralPath \(Join-Path \(npm\.cmd root --global\) 'orch-os'\)$/],
    ["on-path", /^Get-Command orch -ErrorAction SilentlyContinue$/],
    ["home", /^Test-Path -LiteralPath \$\(if \(\$env:ORCH_HOME\) \{ \$env:ORCH_HOME \} elseif \(\$env:HOME\) \{ Join-Path \$env:HOME '\.orch' \} else \{ Join-Path \$env:USERPROFILE '\.orch' \}\)$/],
    ["install", /^npm\.cmd install --global orch-os@\S+$/],
    ["init", /^orch\.cmd init --no-profile --no-handbook$/],
    ["version", /^orch\.cmd --version$/],
    ["doctor", /^orch\.cmd doctor$/],
  ],
};
const kindOf = (group: "macOS" | "Windows 11", command: string) => STEP_KINDS[group].find(([, re]) => re.test(command))?.[0] ?? `unrecognised: ${command}`;
const guideText = () => (existsSync(join(ROOT, GUIDE)) ? read(GUIDE) : "");
/** Every text in backticks, in order. */
const spans = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const NODE_MISSING = "`node` is not found.";
const NODE_OLDER = `\`node --version\` prints a version lower than \`v${FLOOR}\`.`;
const NOT_RUN_LABEL = "**Not run by the authors.** The install command below has not been run by the authors of this guide. What it installs, and every result this case names after it, is unverified until the user's machine shows it.";
const NODEJS_DOWNLOAD = "https://nodejs.org/en/download";
/** Per group: the command that looks for the installer, the install command, and the command that prints where `node` is. */
const NODE_COMMANDS: Record<"macOS" | "Windows 11", { find: string; install: string; where: string }> = {
  macOS: { find: "command -v brew", install: "brew install node", where: "command -v node" },
  "Windows 11": { find: "Get-Command winget -ErrorAction SilentlyContinue", install: "winget install --id OpenJS.NodeJS.LTS --exact --source winget", where: "(Get-Command node).Source" },
};
/** A command that raises privilege, forces, or changes PATH or a shell startup file. */
const RISKY = /\bsudo\b|\brunas\b|--force\b|-Force\b|\bPATH\s*=|\$env:PATH\b|\bsetx\b|SetEnvironmentVariable|\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b|\$PROFILE\b/i;

/** The first step of a group with its indented lines, and the text of each case under it by title. */
function nodeStep(group: string): { block: string; cases: Record<string, string> } {
  const block = /^1\. .*\n(?: .*\n)*/m.exec(group)?.[0] ?? "";
  const cases: Record<string, string> = {};
  for (const part of block.split(/^ {3}- \*\*/m).slice(1)) {
    const end = part.indexOf("**");
    cases[part.slice(0, end)] = part.slice(end + 2);
  }
  return { block, cases };
}

describe("InstallEntry", () => {
  it("each_readme_has_one_paste_sentence_that_names_the_guide", () => {
    for (const [file, title, end] of [["README.md", "Install", "."], ["README.zh.md", "安装", "。"]] as const) {
      const blocks = [...section(read(file), title).matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
      expect(blocks.length, `${file}: sentences to paste in the install section`).toBe(1);
      const sentence = blocks[0];
      expect(sentence.includes("\n"), `${file}: the sentence is one line`).toBe(false);
      expect(sentence.match(/[.!?。！？](?=\s|$)/g), `${file}: the block is one sentence`).toEqual([end]);
      expect(sentence.split(GUIDE).length - 1, `${file}: the sentence names ${GUIDE} once`).toBe(1);
      expect(sentence.split(REPOSITORY).length - 1, `${file}: the sentence names the repository once`).toBe(1);
      expect(sentence.match(/\S+\.md\b/g), `${file}: the sentence names one file`).toEqual([GUIDE]);
    }
  });

  it("the_guide_is_the_one_docs_file_in_the_package_file_list", () => {
    expect(existsSync(join(ROOT, GUIDE)), `${GUIDE} exists`).toBe(true);
    expect(pkg.files.filter((f: string) => f.startsWith("docs")), "docs entries in package.json files").toEqual([
      GUIDE,
      "docs/preferences.md",
      "docs/resume.md",
    ]);
  });

  it("packed_tarball_contains_the_guide_at_the_path_the_readme_names", () => {
    const dirs: string[] = [];
    try {
      const copy = candidate(dirs);
      const files = copy.run("tar", ["-tzf", pack(copy)]).trim().split("\n");
      expect(files.filter((f) => f.startsWith("package/docs/")), "docs files in the tarball").toEqual([
        `package/${GUIDE}`,
        "package/docs/preferences.md",
        "package/docs/resume.md",
      ]);
      expect(files, "the READMEs are in the tarball").toEqual(expect.arrayContaining(["package/README.md", "package/README.zh.md"]));
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  // The macOS group's already-installed check, run as the guide writes it against real npm prefixes. Each prefix
  // is a new directory under the system temporary directory; npm reads no user config and uses no network.
  it.skipIf(WINDOWS)("guide_installed_check_answers_on_a_fresh_prefix_and_on_a_used_one", () => {
    const check = steps(section(guideText(), "macOS"))[1]?.command ?? "";
    expect(check.length > 0, "the macOS group has a second step").toBe(true);
    const dirs: string[] = [];
    try {
      const copy = candidate(dirs);
      const tarball = pack(copy);
      const prefixed = (prefix: string) => ({ cwd: copy.dir, env: { ...copy.env, NPM_CONFIG_PREFIX: prefix }, encoding: "utf8" as const, timeout: 30_000 });
      const install = (prefix: string, what: string) => {
        const r = spawnSync(npmCommand, ["install", "--global", "--install-links", what], prefixed(prefix));
        expect(r.status, `npm install --global ${what}\n${r.stdout}\n${r.stderr}`).toBe(0);
      };
      /** What the step's command says about one prefix, in the words of the step. */
      const answer = (prefix: string): string => {
        const r = spawnSync("/bin/sh", ["-c", check], prefixed(prefix));
        const out = `${r.stdout}${r.stderr}`;
        if (/^npm error/m.test(out)) return `${out.split("\n")[0]} (exit ${r.status})`;
        if (r.status === 0 && r.stdout.trim().endsWith("/node_modules/orch-os")) return "installed";
        if (r.status !== 0 && r.stdout === "" && /\/node_modules\/orch-os'?: No such file or directory\n$/.test(r.stderr)) return "not installed";
        return `no answer (exit ${r.status}): ${out}`;
      };
      const [fresh, used, installed] = ["fresh", "used", "installed"].map((name) => join(copy.dir, `prefix-${name}`));
      mkdirSync(fresh);
      expect(answer(fresh), "prefix with no lib directory: answer of the already-installed check").toBe("not installed");
      expect(readdirSync(fresh), "prefix with no lib directory: entries after the check").toEqual([]);
      const other = join(copy.dir, "other-global-package");
      mkdirSync(other);
      writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other-global-package", version: "1.0.0" }));
      install(used, other);
      expect(readdirSync(join(used, "lib", "node_modules")), "prefix with another global package: its packages").toEqual(["other-global-package"]);
      expect(answer(used), "prefix with another global package: answer of the already-installed check").toBe("not installed");
      install(installed, tarball);
      expect(readdirSync(join(installed, "lib", "node_modules")), "prefix with orch-os installed: its packages").toEqual(["orch-os"]);
      expect(answer(installed), "prefix with orch-os installed: answer of the already-installed check").toBe("installed");
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guide_install_commands_pin_the_package_version", () => {
    const guide = guideText();
    expect(guide.length > 0, `${GUIDE} exists`).toBe(true);
    // every command in the guide that names a package manager, per group: the lookup of the Node.js installer and
    // its install command, the already-installed check, and the pinned install; nothing else
    const commands = spans(guide).filter((c) => /\b(?:npm|npx|pnpm|yarn|bun|brew|winget|choco|scoop|nvm|fnm|volta)(?:\.cmd)?\b/.test(c));
    expect(commands, "package-manager commands in the guide").toEqual([
      NODE_COMMANDS.macOS.find, NODE_COMMANDS.macOS.install, 'ls -d "$(npm root --global)/orch-os"', `npm install --global orch-os@${pkg.version}`,
      NODE_COMMANDS["Windows 11"].find, NODE_COMMANDS["Windows 11"].install, "Test-Path -LiteralPath (Join-Path (npm.cmd root --global) 'orch-os')", `npm.cmd install --global orch-os@${pkg.version}`,
    ]);
    const versions = [...guide.matchAll(/\borch-os@([^\s`'"]*)/g)].map((m) => m[1]);
    expect([...new Set(versions)], "every orch-os@VERSION spec in the guide").toEqual([pkg.version]);
    expect(guide.match(/`orch \d[^`]*`/g), "version outputs the guide expects").toEqual([`\`orch ${pkg.version}\``, `\`orch ${pkg.version}\``]);
  });

  it("guide_has_two_command_groups_that_refuse_first_and_end_with_version_and_doctor", () => {
    const guide = guideText();
    expect(guide.length > 0, `${GUIDE} exists`).toBe(true);
    expect([...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1]), "guide sections").toEqual(["Rules", "macOS", "Windows 11", "Limits"]);
    expect(section(guide, "Rules"), "the guide tells the assistant to name the operating system").toMatch(/Tell the user which operating system you detected/);
    expect(section(guide, "Rules"), "the guide allows exactly one group").toMatch(/follow exactly one group/);
    const order = ["node", "installed", "on-path", "home", "install", "init", "version", "doctor"];
    for (const group of ["macOS", "Windows 11"] as const) {
      const list = steps(section(guide, group));
      expect(list.map((s) => kindOf(group, s.command)), `${group}: steps in order`).toEqual(order);
      for (const kind of ["installed", "on-path", "home"]) {
        const step = list[order.indexOf(kind)];
        expect(/\bstop\b/.test(step?.text ?? ""), `${group}: the ${kind} check tells the assistant to stop`).toBe(true);
      }
      expect(list.at(-2)?.text, `${group}: expected version output`).toContain(`\`orch ${pkg.version}\``);
      expect(list.at(-1)?.text, `${group}: expected doctor summary`).toContain("`doctor: PASS (0 required check(s) failed)`");
    }
    // one program name per group: npm and orch on macOS, npm.cmd and orch.cmd on Windows 11
    expect(/\b(?:npm|orch)\.cmd\b/.test(section(guide, "macOS")), "macOS group uses a .cmd program").toBe(false);
    expect(steps(section(guide, "Windows 11")).filter((s) => /^(?:npm|orch) /.test(s.command)), "Windows 11 steps that do not use the .cmd program").toEqual([]);
  });

  // Step 1 of each group: a missing Node.js may be installed, with a command labelled as not run by the authors;
  // a Node.js that is there and older than the floor gets no install, replacement or upgrade.
  it("guide_node_step_installs_a_missing_node_and_changes_no_older_one", () => {
    const guide = guideText();
    expect(guide.length > 0, `${GUIDE} exists`).toBe(true);
    for (const group of ["macOS", "Windows 11"] as const) {
      const text = section(guide, group);
      const { find, install, where } = NODE_COMMANDS[group];
      expect(spans(text).filter((c) => RISKY.test(c)), `${group}: commands that add sudo, --force or a PATH edit`).toEqual([]);
      const { block, cases } = nodeStep(text);
      expect(block.split("\n")[0], `${group}: step 1 names the floor of package.json`).toContain(`\`node --version\` must print \`v${FLOOR}\` or a higher major version.`);
      expect(Object.keys(cases), `${group}: cases of step 1`).toEqual([NODE_MISSING, NODE_OLDER]);
      const older = cases[NODE_OLDER] ?? "";
      expect(older.startsWith(" Do not install, replace or upgrade anything. "), `${group}: the older-Node case opens by ruling out an install, a replacement and an upgrade`).toBe(true);
      expect(spans(older), `${group}: commands in the older-Node case`).toEqual([where]);
      expect(older.match(/\b(?:brew|winget|npm|npx|nvm|fnm|volta|choco|scoop|installer|homebrew)\b/gi), `${group}: installers named in the older-Node case`).toBeNull();
      expect(older, `${group}: the older-Node case says other software may depend on that Node.js`).toContain("other software on this machine may depend on this Node.js");
      expect(/\bThen stop, and give the user two choices: upgrade this Node\.js themselves, or set up a separate Node\.js \d+ or newer\./.test(older), `${group}: the older-Node case stops with the two choices`).toBe(true);
      const missing = cases[NODE_MISSING] ?? "";
      expect(missing.split(NOT_RUN_LABEL).length - 1, `${group}: the missing-Node case carries the not-run-by-the-authors label once`).toBe(1);
      expect(missing.indexOf(NOT_RUN_LABEL) < missing.indexOf(`\`${install}\``), `${group}: the label comes before the install command`).toBe(true);
      expect(spans(missing), `${group}: commands and outputs in the missing-Node case`).toEqual([find, install, "node --version", `v${FLOOR}`, "node", "PATH"]);
      expect(missing.split(NODEJS_DOWNLOAD).length - 1, `${group}: the missing-Node case names the Node.js download page once`).toBe(1);
      expect(/process and run `node --version` in it\./.test(missing), `${group}: the missing-Node case checks node again in a new process`).toBe(true);
      expect(missing, `${group}: the missing-Node case rules out a PATH edit`).toContain("Do not edit `PATH` or any startup file of the shell.");
      expect(missing.match(/\bstop\b/g)?.length, `${group}: stops in the missing-Node case`).toBe(3);
    }
    // one label in each group and none anywhere else
    expect(guide.split(NOT_RUN_LABEL).length - 1, "not-run-by-the-authors labels in the guide").toBe(2);
  });

  it("guide_labels_every_windows_step_unverified", () => {
    const guide = guideText();
    expect(guide.length > 0, `${GUIDE} exists`).toBe(true);
    const windows = section(guide, "Windows 11");
    const label = "**Unverified on Windows.** The steps in this group have not been run on a Windows machine. Every expected result below is unverified until the user's machine shows it.";
    expect(windows.trimStart().startsWith(label), "the Windows 11 group opens with the unverified label").toBe(true);
    // outside that group the guide only names the system; it makes no statement about how Windows behaves
    const elsewhere = guide.replace(windows, "\n").split("\n").filter((l) => /windows|powershell|\.cmd\b/i.test(l));
    expect(elsewhere, "lines about Windows outside the labelled group").toEqual([
      "For a coding assistant that can run commands on the user's machine. It covers one case: a first install of `orch-os@" + pkg.version + "` on macOS or Windows 11. It does not upgrade, repair or remove anything.",
      "- Tell the user which operating system you detected, then follow exactly one group below: **macOS** or **Windows 11**. On any other system, stop: this guide has no group for it.",
      "## Windows 11",
    ]);
  });

  it("docs_state_the_doctor_node_floor_the_cli_applies", () => {
    const history = `\`node>=${FLOOR}\` (\`node>=20\` in 2.0.0 through 2.1.0)`;
    expect(read("docs/migration.md").split("node>=20").length - 1, "docs/migration.md: old row name appears once").toBe(1);
    expect(read("docs/migration.md"), "docs/migration.md: the old row name is marked as history").toContain(history);
    for (const file of ["README.md", "README.zh.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md") && f !== "migration.md").map((f) => `docs/${f}`)]) {
      expect(read(file).includes("node>=20"), `${file}: states the old node row`).toBe(false);
    }
    expect(read("docs/commands.md"), "docs/commands.md: doctor required checks").toContain(`| Node.js ≥ ${FLOOR}, POSIX platform, config readable,`);
    expect(read("docs/faq.md"), "docs/faq.md: doctor prerequisites").toContain(`With Node.js ≥ ${FLOOR} and git on a POSIX system, the doctor passes.`);
  });
});

describe("InstallEntryDocsMatchDoctor", () => {
  const d = useNoAgents();

  it("demo_shows_the_node_row_and_the_agent_row_as_doctor_prints_them", async () => {
    expect((await run("init"))[0]).toBe(0);
    const [, out] = await run("doctor");
    const line = (name: string) => out.split("\n").find((l) => l.slice(6).startsWith(name))!;
    const demo = read("docs/DEMO.md");
    expect(demo, "docs/DEMO.md: node row").toContain(line("node>=").replace(process.versions.node, "<version>") + "\n");
    expect(demo, "docs/DEMO.md: agent CLIs row").toContain(line("agent CLIs") + "\n");
  });

  // The guide's steps 6-8 on a home that did not exist, and what its Limits section says about them.
  it("guide_steps_on_a_new_home_end_in_a_passing_doctor", async () => {
    rmSync(d.home, { recursive: true, force: true });
    expect(C.orchHome(), "the home is ORCH_HOME when it is set").toBe(d.home);
    const [ic, iout] = await run("init", "--no-profile", "--no-handbook");
    // the two files it reports, whichever separator the system prints before the file name
    const wrote = iout.split("\n").filter((l) => l.startsWith("wrote ")).map((l) => slash(l.slice(6)));
    expect([ic, wrote, iout.endsWith("next: orch doctor\n")], `init on a new home\n${iout}`)
      .toEqual([0, [slash(join(d.home, "config.toml")), slash(join(d.home, "mailbox.md"))], true]);
    expect(readdirSync(d.home).sort(), "what init --no-profile --no-handbook leaves in a new home").toEqual(["config.toml", "mailbox.md", "workers"]);
    const config = readFileSync(join(d.home, "config.toml"), "utf8");
    expect(config.includes("[profile"), "config.toml has a [profile] table").toBe(false);
    expect((await run("--version"))[1], "orch --version").toBe(`orch ${pkg.version}\n`);
    const [dc, dout] = await run("doctor");
    expect(dout.endsWith("doctor: PASS (0 required check(s) failed)\n"), `doctor summary\n${dout}`).toBe(true);
    expect(dc, "doctor exit code").toBe(0);
    expect(rowsOf(dout).find((r) => r[1] === "handbook")?.[0], "handbook row after --no-handbook").toBe("SKIP");
    // a second init: the message that tells the assistant a home already existed, and the config left as it was
    const [, again] = await run("init", "--no-profile", "--no-handbook");
    expect(again, "init on an existing home").toContain(`config exists: ${join(d.home, "config.toml")} (unchanged; --force rewrites it)`);
    // a later plain init writes the handbook and keeps config.toml
    expect((await run("init"))[0]).toBe(0);
    expect(readFileSync(join(d.home, "config.toml"), "utf8"), "config.toml after a later plain init").toBe(config);
    expect(rowsOf((await run("doctor"))[1]).find((r) => r[1] === "handbook")?.[0], "handbook row after a later plain init").toBe("PASS");
  });

  it("init_force_replaces_an_edited_config_and_keeps_only_the_profile_tables", async () => {
    const flags = ["--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1"];
    expect((await run("init", "--no-handbook", ...flags))[0]).toBe(0);
    const path = join(d.home, "config.toml");
    const first = readFileSync(path, "utf8");
    expect(first.includes("[profile]"), "config.toml written from profile flags has [profile]").toBe(true);
    writeFileSync(path, first.replace('team = "my-team"', 'team = "edited"'));
    expect((await run("init", "--force", "--no-handbook"))[0]).toBe(0);
    expect(readFileSync(path, "utf8"), "config.toml after init --force").toBe(first);
  });

  it("the_home_is_orch_home_when_set_and_not_empty_else_dot_orch_under_home", () => {
    const saved = { ORCH_HOME: process.env.ORCH_HOME, HOME: process.env.HOME };
    try {
      process.env.HOME = d.bins;
      process.env.ORCH_HOME = "";
      expect(C.orchHome(), "empty ORCH_HOME").toBe(join(d.bins, ".orch"));
      delete process.env.ORCH_HOME;
      expect(C.orchHome(), "unset ORCH_HOME").toBe(join(d.bins, ".orch"));
      process.env.ORCH_HOME = d.home;
      expect(C.orchHome(), "set ORCH_HOME").toBe(d.home);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("init_writes_config_and_mailbox_with_plain_writes", () => {
    rmSync(d.home, { recursive: true, force: true });
    const r = observed(d.home, "init", "--no-profile", "--no-handbook");
    expect(r.status, `init exit code\n${r.stdout}`).toBe(0);
    const fileOps = r.ops.filter((o) => o.kind === "fs" && !o.op.startsWith("mkdir")).map((o) => `${o.op} ${slash(o.path)}`);
    expect(fileOps, "file operations of init --no-profile --no-handbook on a new home").toEqual([
      `writeFileSync ${slash(join(d.home, "config.toml"))}`, `writeFileSync ${slash(join(d.home, "mailbox.md"))}`,
    ]);
    expect(r.ops.filter((o) => o.kind === "process"), "processes started by init").toEqual([]);
  });
});

describe("PublicTextManifest", () => {
  useNoAgents();

  it("public_text_manifest_matches_the_files_and_the_doctor_output", async () => {
    const path = join(ROOT, "tests", "fixtures", "part1-public-text.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof manifest.owner_approved, "owner_approved is recorded").toBe("boolean");
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    const doctor = (await run("doctor"))[1];
    const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
    expect(manifest.blocks.length, "blocks in the manifest").toBeGreaterThan(0);
    for (const b of manifest.blocks) {
      if (b.whole_file) {
        expect(sha(readFileSync(join(ROOT, b.file))), `${b.id}: sha256 of ${b.file}`).toBe(b.sha256);
        continue;
      }
      expect(sha(b.text), `${b.id}: sha256 of the recorded text`).toBe(b.sha256);
      const where = b.command === "orch doctor" ? doctor : read(b.file);
      expect(where.split(b.text).length - 1, `${b.id}: the recorded text appears once in ${b.command ?? b.file}`).toBe(1);
    }
  });
});
