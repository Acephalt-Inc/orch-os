// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Mutations for tests/doctor-install-entry.test.ts. Each row changes one thing in a disposable copy
// of this checkout, rebuilds it, and runs one named test of that file there with a second vitest.
//
// A row counts as KILLED only when the named test passed in the unchanged copy, the changed copy
// built, the named test ran, and it failed on the assertion message given for the row. Anything
// else that goes wrong (a build error, a file that does not load, a thrown error that is not that
// assertion) is INVALID, and the three rows at the end show the harness saying so.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, WINDOWS } from "./_helpers.js";

const TEST_FILE = "tests/doctor-install-entry.test.ts";
const GUIDE = "docs/INSTALL-WITH-AGENT.md";
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
type Verdict = "PASSED" | "KILLED" | "INVALID";
type Result = { verdict: Verdict; detail: string };
type Edit = { file: string; from?: string; to?: string; remove?: true };
const NODE_STEP = "guide_node_step_installs_a_missing_node_and_changes_no_older_one";
/** Runs the guide's command in a POSIX shell, so it is skipped on Windows, and so is its row. */
const INSTALLED_CHECK = "guide_installed_check_answers_on_a_fresh_prefix_and_on_a_used_one";
const NOT_RUN_LINE = "     - **Not run by the authors.** The install command below has not been run by the authors of this guide. What it installs, and every result this case names after it, is unverified until the user's machine shows it.\n";

let copy = "";
let control: Record<string, string> = {};

function node(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VITEST/.test(k)));
  return spawnSync(process.execPath, args, { cwd: copy, env, encoding: "utf8", timeout: 170_000 });
}

/** Compile the copy, run the test file (one named test, or all of it), and return each test's status and failure text. */
function runTests(name?: string): { built: boolean; tests: Record<string, { status: string; failure: string }>; raw: string } {
  const build = node([join(copy, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);
  if (build.status !== 0) return { built: false, tests: {}, raw: `${build.stdout}${build.stderr}` };
  const report = join(copy, "report.json");
  rmSync(report, { force: true });
  const r = node([join(copy, "node_modules", "vitest", "vitest.mjs"), "run", TEST_FILE, ...(name ? ["-t", name] : []), "--reporter=json", `--outputFile=${report}`]);
  const raw = `${r.stdout}${r.stderr}`;
  if (!existsSync(report)) return { built: true, tests: {}, raw };
  const tests: Record<string, { status: string; failure: string }> = {};
  for (const file of JSON.parse(readFileSync(report, "utf8")).testResults) {
    for (const t of file.assertionResults) tests[t.title] = { status: t.status, failure: (t.failureMessages ?? []).join("\n") };
  }
  return { built: true, tests, raw };
}

/** Apply `edits` to the copy, run the named test, put the files back, and classify the outcome. */
function mutate(name: string, edits: Edit[], expected: RegExp): Result {
  const saved = edits.map((e) => [e.file, readFileSync(join(copy, e.file))] as const);
  try {
    for (const e of edits) {
      if (e.remove) {
        rmSync(join(copy, e.file));
        continue;
      }
      const text = readFileSync(join(copy, e.file), "utf8");
      if (text.split(e.from!).length !== 2) return { verdict: "INVALID", detail: `${e.file}: the text to change does not appear exactly once` };
      writeFileSync(join(copy, e.file), text.replace(e.from!, () => e.to!));
    }
    const run = runTests(name);
    if (!run.built) return { verdict: "INVALID", detail: `the changed copy did not build\n${run.raw}` };
    const t = run.tests[name];
    if (!t) return { verdict: "INVALID", detail: `the named test did not run\n${run.raw}` };
    if (t.status === "passed") return { verdict: "PASSED", detail: "the named test still passes" };
    if (t.status !== "failed") return { verdict: "INVALID", detail: `the named test ended as ${t.status}` };
    if (!/AssertionError/.test(t.failure) || !expected.test(t.failure)) return { verdict: "INVALID", detail: `the named test failed, but not on the row's assertion\n${t.failure}` };
    return { verdict: "KILLED", detail: t.failure.split("\n")[0] };
  } finally {
    for (const [file, bytes] of saved) writeFileSync(join(copy, file), bytes);
  }
}

/** One mutation row: the unchanged copy passes the named test, and the changed copy fails it on `expected`. */
function row(name: string, edits: Edit[], expected: RegExp): void {
  expect(control[name], `control: ${name} in the unchanged copy`).toBe("passed");
  const result = mutate(name, edits, expected);
  expect(result, result.detail).toMatchObject({ verdict: "KILLED" });
  console.log(`[mutation] ${name}: control passed; changed copy ${result.verdict}: ${result.detail}`);
}

/** A harness check: this change must be classified INVALID, with `reason` in the detail. */
function invalid(name: string, edits: Edit[], expected: RegExp, reason: string): void {
  const result = mutate(name, edits, expected);
  expect(result.verdict, result.detail).toBe("INVALID");
  expect(result.detail).toContain(reason);
  console.log(`[mutation] harness check on ${name}: ${result.verdict}: ${result.detail.split("\n")[0]} (${reason})`);
}

beforeAll(() => {
  copy = mkdtempSync(join(tmpdir(), "orch-mut-"));
  for (const entry of readdirSync(ROOT)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(entry) || entry.endsWith(".tgz")) continue;
    cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  }
  // the installed compiler and test runner, without installing anything (a junction on Windows needs no privilege)
  symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), WINDOWS ? "junction" : "dir");
  const run = runTests();
  expect(run.built, `the unchanged copy builds\n${run.raw}`).toBe(true);
  control = Object.fromEntries(Object.entries(run.tests).map(([k, v]) => [k, v.status]));
  expect(Object.keys(control).length, `the unchanged copy ran the test file\n${run.raw}`).toBeGreaterThan(0);
});

afterAll(() => {
  if (copy) rmSync(copy, { recursive: true, force: true });
});

describe("DoctorInstallEntryMutations", () => {
  it("mutation_node_floor_lowered_to_21", () => {
    row("doctor_node_row_fails_below_the_engines_floor_and_passes_from_it",
      [{ file: "src/cli.ts", from: 'add(major >= 22, "node>=22"', to: 'add(major >= 21, "node>=22"' }],
      /node version fixture 21\.99\.99: row status: expected 'PASS' to be 'FAIL'/);
  });

  it("mutation_node_row_keeps_the_old_name", () => {
    row("doctor_node_row_is_named_after_the_package_engines_floor",
      [{ file: "src/cli.ts", from: 'add(major >= 22, "node>=22"', to: 'add(major >= 22, "node>=20"' }],
      /doctor node row name: expected 'node>=20' to be 'node>=22'/);
  });

  it("mutation_old_force_hint_restored", () => {
    row("doctor_agent_row_points_at_no_command_that_rewrites_files",
      [{
        file: "src/cli.ts",
        from: '`none found (this run looked for ${D.KNOWN.map((k) => k[0]).join(", ")}; \\`orch agents\\` lists each as found or absent)`',
        to: '"none found (install one, then `orch init --force`)"',
      }],
      /agent CLIs row text with no agent CLI: expected 'none found \(install one, then `orch i/);
  });

  it("mutation_hint_names_a_second_command", () => {
    row("doctor_agent_row_points_at_no_command_that_rewrites_files",
      [{ file: "src/cli.ts", from: "\\`orch agents\\` lists each as found or absent)`", to: "\\`orch agents\\` lists each as found or absent; then \\`orch init --force\\`)`" }],
      /agent CLIs row text with no agent CLI: expected 'none found \(this run looked for claud/);
  });

  it("mutation_orch_agents_rewrites_config_with_the_same_bytes", () => {
    row("orch_agents_changes_no_file_and_starts_no_process",
      [{
        file: "src/cli.ts", from: "  const rows = D.detect();\n  const configured",
        to: "  const rows = D.detect();\n  if (existsSync(C.configPath())) writeFileSync(C.configPath(), readFileSync(C.configPath()));\n  const configured",
      }],
      /file changes and process starts during orch agents: expected \[ \{ kind: 'fs', …\(2\) \} \] to deeply equal \[\]/);
  });

  it("mutation_orch_agents_starts_a_process", () => {
    row("orch_agents_changes_no_file_and_starts_no_process",
      [
        { file: "src/cli.ts", from: 'import { dirname, join } from "node:path";', to: 'import { dirname, join } from "node:path";\nimport { spawnSync as startedByMutant } from "node:child_process";' },
        { file: "src/cli.ts", from: "  const rows = D.detect();\n  const configured", to: '  const rows = D.detect();\n  startedByMutant(process.execPath, ["-e", ""]);\n  const configured' },
      ],
      /file changes and process starts during orch agents: expected \[ \{ kind: 'process', …\(2\) \} \] to deeply equal \[\]/);
  });

  it("mutation_guide_install_unpinned", () => {
    row("guide_install_commands_pin_the_package_version",
      [{ file: GUIDE, from: `\`npm install --global orch-os@${VERSION}\``, to: "`npm install --global orch-os`" }],
      /package-manager commands in the guide: expected \[ 'command -v brew', …\(7\) \] to deeply equal \[ 'command -v brew', …\(7\) \]/);
  });

  it("mutation_package_version_moves_and_the_guide_does_not", () => {
    row("guide_install_commands_pin_the_package_version",
      [{ file: "package.json", from: `"version": "${VERSION}"`, to: '"version": "99.0.0"' }],
      /package-manager commands in the guide: expected \[ 'command -v brew', …\(7\) \] to deeply equal \[ 'command -v brew', …\(7\) \]/);
  });

  it("mutation_guide_introduction_names_another_version", () => {
    row("guide_install_commands_pin_the_package_version",
      [{ file: GUIDE, from: `a first install of \`orch-os@${VERSION}\``, to: "a first install of `orch-os@0.0.1`" }],
      /every orch-os@VERSION spec in the guide: expected \[ '0\.0\.1', '.+' \] to deeply equal \[ '.+' \]/);
  });

  it("mutation_guide_removed_from_package_files", () => {
    row("packed_tarball_contains_the_guide_at_the_path_the_readme_names",
      [{ file: "package.json", from: `    "${GUIDE}",\n`, to: "" }],
      /docs files in the tarball: expected \[\] to deeply equal \[ Array\(1\) \]/);
  });

  it("mutation_guide_home_check_no_longer_stops", () => {
    row("guide_has_two_command_groups_that_refuse_first_and_end_with_version_and_doctor",
      [{ file: GUIDE, from: " If it prints the directory, stop: an ORCH-os home already exists there.", to: "" }],
      /macOS: the home check tells the assistant to stop: expected false to be true/);
  });

  it("mutation_guide_ends_with_init_instead_of_doctor", () => {
    row("guide_has_two_command_groups_that_refuse_first_and_end_with_version_and_doctor",
      [{ file: GUIDE, from: "8. `orch doctor` must end", to: "8. `orch init` must end" }],
      /macOS: steps in order: expected \[ Array\(8\) \] to deeply equal \[ Array\(8\) \]/);
  });

  it.skipIf(WINDOWS)("mutation_guide_installed_check_restored_to_npm_ls", () => {
    row(INSTALLED_CHECK,
      [{
        file: GUIDE,
        from: '2. `ls -d "$(npm root --global)/orch-os"` must fail with `No such file or directory` for a path that ends in `/node_modules/orch-os`. If it prints a directory, stop',
        to: "2. `npm ls --global --depth=0` must not list an `orch-os` package. If it does, stop",
      }],
      /prefix with no lib directory: answer of the already-installed check: expected 'npm error code ENOENT \(exit 254\)' to be 'not installed'/);
  });

  it("mutation_guide_older_node_case_upgrades_node", () => {
    row(NODE_STEP,
      [{ file: GUIDE, from: "Do not install, replace or upgrade anything. Run `command -v node` and show", to: "Run `brew upgrade node`, then run `command -v node` and show" }],
      /macOS: the older-Node case opens by ruling out an install, a replacement and an upgrade: expected false to be true/);
  });

  it("mutation_guide_older_node_case_gains_an_install_command", () => {
    row(NODE_STEP,
      [{
        file: GUIDE, from: "Run `(Get-Command node).Source` and show the user that path and the version.",
        to: "Run `(Get-Command node).Source` and show the user that path and the version. Then run `winget install --id OpenJS.NodeJS.LTS --exact --source winget`.",
      }],
      /Windows 11: commands in the older-Node case: expected \[ '\(Get-Command node\)\.Source', …\(1\) \] to deeply equal \[ '\(Get-Command node\)\.Source' \]/);
  });

  it("mutation_guide_missing_node_case_loses_the_not_run_label", () => {
    row(NODE_STEP,
      [{ file: GUIDE, from: `${NOT_RUN_LINE}     - \`command -v brew\``, to: "     - `command -v brew`" }],
      /macOS: the missing-Node case carries the not-run-by-the-authors label once: expected \+0 to be 1/);
  });

  it("mutation_guide_missing_node_label_says_the_command_was_run", () => {
    row(NODE_STEP,
      [{
        file: GUIDE, from: `${NOT_RUN_LINE}     - \`Get-Command winget`,
        to: "     - **Run by the authors.** The install command below has been run by the authors of this guide.\n     - `Get-Command winget",
      }],
      /Windows 11: the missing-Node case carries the not-run-by-the-authors label once: expected \+0 to be 1/);
  });

  it("mutation_guide_node_install_gains_sudo", () => {
    row(NODE_STEP,
      [{ file: GUIDE, from: "- `brew install node` must exit 0.", to: "- `sudo brew install node` must exit 0." }],
      /macOS: commands that add sudo, --force or a PATH edit: expected \[ 'sudo brew install node' \] to deeply equal \[\]/);
  });

  it("mutation_guide_node_install_gains_force", () => {
    row(NODE_STEP,
      [{ file: GUIDE, from: "--source winget` must exit 0.", to: "--source winget --force` must exit 0." }],
      /Windows 11: commands that add sudo, --force or a PATH edit: expected \[ Array\(1\) \] to deeply equal \[\]/);
  });

  it("mutation_guide_node_install_is_followed_by_a_path_edit", () => {
    row(NODE_STEP,
      [{ file: GUIDE, from: "- `brew install node` must exit 0.", to: '- `brew install node && export PATH="$HOME/bin:$PATH"` must exit 0.' }],
      /macOS: commands that add sudo, --force or a PATH edit: expected \[ Array\(1\) \] to deeply equal \[\]/);
  });

  it("mutation_windows_label_removed", () => {
    row("guide_labels_every_windows_step_unverified",
      [{ file: GUIDE, from: "**Unverified on Windows.** The steps in this group have not been run on a Windows machine. ", to: "" }],
      /the Windows 11 group opens with the unverified label: expected false to be true/);
  });

  it("mutation_readme_sentence_points_at_another_file", () => {
    row("each_readme_has_one_paste_sentence_that_names_the_guide",
      [{ file: "README.md", from: `by following ${GUIDE} from`, to: "by following docs/faq.md from" }],
      /README\.md: the sentence names docs\/INSTALL-WITH-AGENT\.md once: expected \+0 to be 1/);
  });

  it("mutation_docs_keep_the_old_node_floor", () => {
    row("docs_state_the_doctor_node_floor_the_cli_applies",
      [{ file: "docs/faq.md", from: "With Node.js ≥ 22 and git", to: "With Node.js ≥ 20 and git" }],
      /docs\/faq\.md: doctor prerequisites: expected .+ to contain 'With Node\.js ≥ 22 and git on a POSIX/);
  });

  it("mutation_demo_keeps_the_old_agent_hint", () => {
    row("demo_shows_the_node_row_and_the_agent_row_as_doctor_prints_them",
      [{ file: "docs/DEMO.md", from: "none found (this run looked for claude, codex, gemini, qwen; `orch agents` lists each as found or absent)", to: "none found (install one, then `orch init --force`)" }],
      /docs\/DEMO\.md: agent CLIs row: expected .+ to contain 'SKIP {2}agent CLIs/);
  });
});

describe("DoctorInstallEntryMutationHarness", () => {
  const name = "doctor_node_row_is_named_after_the_package_engines_floor";
  const expected = /doctor node row name: expected/;
  const afterImports = 'import { dirname, join } from "node:path";';

  it("invalid_a_runtime_error_in_the_product_is_not_a_kill", () => {
    invalid(name,
      [{ file: "src/cli.ts", from: "  const rows: [string, string, string][] = [];\n  const add =", to: '  if (process.pid > 0) throw new Error("unrelated runtime failure");\n  const rows: [string, string, string][] = [];\n  const add =' }],
      expected, "Error: unrelated runtime failure");
  });

  it("invalid_a_source_file_that_does_not_build_is_not_a_kill", () => {
    invalid(name, [{ file: "src/cli.ts", from: afterImports, to: `${afterImports}\nconst brokenByMutant: number = "not a number";` }], expected, "the changed copy did not build");
  });

  it("invalid_a_source_file_that_does_not_import_is_not_a_kill", () => {
    invalid(name, [{ file: "src/cli.ts", from: afterImports, to: `${afterImports}\nimport "./no-such-module.js";` }], expected, "the named test did not run");
  });

  it("invalid_a_test_file_that_does_not_load_is_not_a_kill", () => {
    invalid(name, [{ file: TEST_FILE, from: 'import * as D from "../src/detect.js";', to: 'import * as D from "../src/no-such-module.js";' }], expected, "the named test did not run");
  });

  it("invalid_a_missing_fixture_is_not_a_kill", () => {
    invalid("public_text_manifest_matches_the_files_and_the_doctor_output", [{ file: "tests/fixtures/part1-public-text.json", remove: true }], /sha256 of/, "ENOENT");
  });

  it("the_copy_is_unchanged_after_the_rows", () => {
    const run = runTests();
    expect(run.built, run.raw).toBe(true);
    expect(Object.fromEntries(Object.entries(run.tests).map(([k, v]) => [k, v.status])), "every test passes again in the copy").toEqual(control);
    const notPassed = Object.entries(control).filter(([test, status]) => status !== "passed" && !(WINDOWS && test === INSTALLED_CHECK));
    expect(notPassed, "tests that did not pass in the unchanged copy").toEqual([]);
  });
});
