// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Mutations for tests/update-check.test.ts. Each row changes one thing in a disposable copy of this
// checkout, rebuilds it, and runs one named test of that file there with a second vitest.
//
// A row counts as KILLED only when the named test passed in the unchanged copy, the changed copy
// built, the named test ran, and it failed on the assertion message given for the row. Anything
// else that goes wrong (a build error, a file that does not load, a child that does not start, a
// thrown error that is not that assertion) is INVALID, and the rows at the end show the harness
// saying so.
//
// Every test the rows run talks only to servers on 127.0.0.1. Where a changed copy would ask for
// another host, the test entry records the attempt and never opens the connection.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, WINDOWS } from "./_helpers.js";

const TEST_FILE = "tests/update-check.test.ts";
const UPDATE = "src/update.ts";
const CLI = "src/cli.ts";
type Verdict = "PASSED" | "KILLED" | "INVALID";
type Result = { verdict: Verdict; detail: string };
type Edit = { file: string; from?: string; to?: string; remove?: true };

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
  const saved = [...new Set(edits.map((e) => e.file))].map((file) => [file, readFileSync(join(copy, file))] as const);
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

// places in the product the rows change
const DEADLINE = '    const deadline = setTimeout(() => finish(unavailable("timeout")), DEADLINE_MS);\n';
const ON_RESPONSE = '    req.on("response", (res) => {\n';
const REDIRECT = '      if (status >= 300 && status < 400) return finish(unavailable("redirect"));\n';
const NOT_200 = '      if (status !== 200) return finish(unavailable(status >= 100 && status <= 599 ? `status ${status}` : "connection failed"));\n';
const CONTENT_TYPE = '      if (type !== "application/json") return finish(unavailable("content type"));\n';
const COUNT = "        total += chunk.length;\n";
const CAP = '        if (total > MAX_BODY_BYTES) return finish(unavailable("too large"));\n';
const ASK = "  const result = await checkLatest(VERSION, a._updateUrl);\n";
const WRITE_LINE = '    io.out(updateLine(VERSION, result) + "\\n");\n';
const EXIT = '  return result.kind === "unavailable" ? 1 : 0;\n';
const INJECT = "  args._updateUrl = runtime.updateUrl;\n";
const PATH_IMPORT = 'import { dirname, join } from "node:path";';

const ONE_CONNECTION = "update_check_makes_one_connection_changes_no_file_and_starts_no_process";
const NO_VARIABLE = "no_environment_variable_redirects_or_disables_the_request";
const DRIP = "a_reply_that_drips_one_byte_every_700_ms_ends_at_the_one_deadline";
const BODY_CAP = "a_body_over_128_kib_is_refused_however_it_is_split";
const BAD_BODY = "a_body_that_is_not_json_or_has_no_usable_version_is_unavailable";
const ORDER = "versions_are_ordered_as_semantic_versions_and_malformed_ones_are_refused";

describe("UpdateCheckMutationsDeadline", () => {
  it("mutation_deadline_removed", () => {
    row(DRIP, [{ file: UPDATE, from: DEADLINE, to: "    const deadline = setTimeout(() => undefined, DEADLINE_MS);\n" }],
      /dripping reply: exit code: expected \+0 to be 1/);
  });

  it("mutation_deadline_restarts_with_every_byte", () => {
    row(DRIP, [{ file: UPDATE, from: COUNT, to: `        deadline.refresh();\n${COUNT}` }],
      /dripping reply: exit code: expected \+0 to be 1/);
  });

  it("mutation_deadline_starts_only_when_the_reply_starts", () => {
    row("a_connection_that_is_never_answered_ends_at_the_one_deadline_and_the_process_exits",
      [
        { file: UPDATE, from: DEADLINE, to: "    let deadline: ReturnType<typeof setTimeout> | undefined;\n" },
        { file: UPDATE, from: ON_RESPONSE, to: `${ON_RESPONSE}      deadline = setTimeout(() => finish(unavailable("timeout")), DEADLINE_MS);\n` },
      ],
      /entry child: main\(\) returned the exit code: expected null to be 13/);
  });

  it("mutation_deadline_is_8_seconds", () => {
    row("a_server_that_accepts_and_never_answers_ends_at_the_one_deadline", [{ file: UPDATE, from: "export const DEADLINE_MS = 800;", to: "export const DEADLINE_MS = 8000;" }],
      /silent server: ended after 8\d\d\d ms, expected within 700 to 1500 ms: expected false to be true/);
  });
});

describe("UpdateCheckMutationsReply", () => {
  it("mutation_body_cap_removed", () => {
    row(BODY_CAP, [{ file: UPDATE, from: CAP, to: "" }], /131073 bytes in 1 KiB chunks: exit code: expected \+0 to be 1/);
  });

  it("mutation_body_cap_applied_to_each_chunk_alone", () => {
    row(BODY_CAP, [{ file: UPDATE, from: COUNT, to: "        total = chunk.length;\n" }], /131073 bytes in 1 KiB chunks: exit code: expected \+0 to be 1/);
  });

  it("mutation_body_cap_one_byte_lower", () => {
    row(BODY_CAP, [{ file: UPDATE, from: "if (total > MAX_BODY_BYTES)", to: "if (total >= MAX_BODY_BYTES)" }],
      /131072 bytes: expected 'update check: unavailable \(too large\)…' to be 'update check: newer version available…'/);
  });

  it("mutation_redirect_followed", () => {
    row("a_redirect_is_refused_and_its_target_is_never_requested",
      [{
        file: UPDATE, from: REDIRECT,
        to: "      if (status >= 300 && status < 400 && res.headers.location) {\n        done = true;\n        clearTimeout(deadline);\n        req?.destroy();\n        agent.destroy();\n"
          + "        return void checkLatest(running, String(res.headers.location)).then(resolve);\n      }\n",
      }],
      /redirect 301: requests for the redirect target: expected 1 to be \+0/);
  });

  it("mutation_404_body_read_as_a_version", () => {
    row("a_not_found_reply_is_unavailable_and_its_body_is_never_read_as_a_version", [{ file: UPDATE, from: NOT_200, to: "" }],
      /a 404 whose body is a document: exit code: expected \+0 to be 1/);
  });

  it("mutation_content_type_not_checked", () => {
    row("a_reply_that_is_not_application_json_is_unavailable", [{ file: UPDATE, from: CONTENT_TYPE, to: "" }],
      /content type 'text\/html': expected \[ \+?0, …\(2\) \] to deeply equal \[ 1, …\(2\) \]/);
  });

  it("mutation_address_with_credentials_accepted", () => {
    row("an_address_other_than_the_registry_or_this_machine_is_refused_without_a_request",
      [{ file: UPDATE, from: ' && u.username === "" && u.password === ""', to: "" }],
      /address 'http:\/\/user:secret@127\.0\.0\.1:9\/orch-os\/latest': expected \[ 1, …\(2\) \] to deeply equal \[ 1, …\(2\) \]/);
  });
});

describe("UpdateCheckMutationsVersions", () => {
  it("mutation_pre_release_ordered_above_its_release", () => {
    row("a_pre_release_of_the_installed_version_is_not_newer", [{ file: UPDATE, from: "x.pre === y.pre ? 0 : x.pre === null ? 1 : -1", to: "x.pre === y.pre ? 0 : x.pre === null ? -1 : 1" }],
      /pre-release of the installed version: stdout: expected 'update check: newer version available…' to be 'update check: no newer version: insta…'/);
  });

  it("mutation_pre_release_parts_ignored", () => {
    row(ORDER, [{ file: UPDATE, from: "  return comparePre(x.pre, y.pre);\n", to: "  return 0;\n" }], /1\.0\.0-alpha against 1\.0\.0-alpha\.1: expected \+0 to be -1/);
  });

  it("mutation_numbers_compared_as_text", () => {
    row(ORDER, [{ file: UPDATE, from: "  if (a.length !== b.length) return a.length < b.length ? -1 : 1;\n", to: "" }], /1\.0\.0-beta\.2 against 1\.0\.0-beta\.11: expected 1 to be -1/);
  });

  it("mutation_v_prefix_accepted", () => {
    row(BAD_BODY, [{ file: UPDATE, from: "new RegExp(`^(0|[1-9]", to: "new RegExp(`^v?(0|[1-9]" }], /a v prefix: expected \[ \+?0, …\(2\) \] to deeply equal \[ 1, …\(2\) \]/);
  });

  it("mutation_malformed_version_reported_as_an_update", () => {
    row(BAD_BODY, [{ file: UPDATE, from: '  if (order === null) return unavailable("invalid version");\n', to: '  if (order === null) return { kind: "newer", offered };\n' }],
      /two parts: expected \[ \+?0, …\(2\) \] to deeply equal \[ 1, …\(2\) \]/);
  });

  it("mutation_version_length_not_bounded", () => {
    row("the_line_is_one_bounded_line_whatever_the_registry_sends", [{ file: UPDATE, from: " || v.length > MAX_VERSION_LENGTH", to: "" }],
      /reply 3: one line of at most 160 characters, got 1000\d\d: expected false to be true/);
  });
});

describe("UpdateCheckMutationsResult", () => {
  it("mutation_result_line_moved_to_stderr", () => {
    row("newer_version_is_offered_on_stdout_with_both_versions_and_exit_0", [{ file: CLI, from: WRITE_LINE, to: '    io.err(updateLine(VERSION, result) + "\\n");\n' }],
      /newer: stdout: expected '' to be 'update check: newer version available…'/);
  });

  it("mutation_unavailable_exits_0", () => {
    row("any_status_other_than_200_is_unavailable", [{ file: CLI, from: EXIT, to: "  return 0;\n" }], /status 201: expected \[ \+?0, …\(2\) \] to deeply equal \[ 1, …\(2\) \]/);
  });

  it("mutation_failed_output_exits_0", () => {
    row("an_output_sink_that_fails_after_a_prefix_gives_exit_1_and_a_later_run_is_unaffected",
      [{ file: CLI, from: "      // no stream is left to say it on\n    }\n    return 1;\n", to: "      // no stream is left to say it on\n    }\n    return 0;\n" }],
      /failing sink: exit code: expected \+0 to be 1/);
  });
});

describe("UpdateCheckMutationsSideEffects", () => {
  it("mutation_state_file_written_and_removed", () => {
    row(ONE_CONNECTION,
      [{ file: CLI, from: ASK, to: `${ASK}  writeFileSync(join(dirname(C.configPath()), "update-check.json"), "{}");\n  unlinkSync(join(dirname(C.configPath()), "update-check.json"));\n` }],
      /a newer version: file changes during update check: expected \[ \{ kind: 'fs', …\(2\) \}, …\(1\) \] to deeply equal \[\]/);
  });

  it("mutation_background_process_started", () => {
    row(ONE_CONNECTION,
      [
        { file: CLI, from: PATH_IMPORT, to: `${PATH_IMPORT}\nimport { spawn as startedByMutant } from "node:child_process";` },
        { file: CLI, from: ASK, to: `${ASK}  startedByMutant(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" }).unref();\n` },
      ],
      /a newer version: processes started during update check: expected \[ \{ kind: 'process', …\(2\) \} \] to deeply equal \[\]/);
  });

  it("mutation_second_request", () => {
    row(ONE_CONNECTION, [{ file: CLI, from: ASK, to: `  await checkLatest(VERSION, a._updateUrl);\n${ASK}` }],
      /a newer version: connections opened during update check: expected \[ Array\(2\) \] to deeply equal \[ '127\.0\.0\.1:\d+' \]/);
  });

  it("mutation_check_runs_after_every_command", () => {
    row("no_other_command_contacts_the_registry",
      [{ file: CLI, from: "    return await cmd.run!(args, io);\n", to: '    const code = await cmd.run!(args, io);\n    if (cmd.name !== "check") await checkLatest(VERSION, args._updateUrl);\n    return code;\n' }],
      /connections attempted by orch config: expected \[ 'registry\.npmjs\.org:443' \] to deeply equal \[\]/);
  });

  it("mutation_environment_variable_names_the_address", () => {
    row(NO_VARIABLE, [{ file: CLI, from: INJECT, to: "  args._updateUrl = process.env.ORCH_UPDATE_URL ?? runtime.updateUrl;\n" }],
      /connections the address named by the environment received: expected 1 to be \+0/);
  });

  it("mutation_environment_variable_turns_the_check_off", () => {
    row(NO_VARIABLE, [{ file: CLI, from: ASK, to: `  if (process.env.ORCH_UPDATE_CHECK === "0") return 0;\n${ASK}` }],
      /connections attempted with the environment set: expected \[\] to deeply equal \[ '127\.0\.0\.1:\d+' \]/);
  });

  it("mutation_request_uses_the_shared_agent", () => {
    row(NO_VARIABLE, [{ file: UPDATE, from: 'headers: { accept: "application/json" }, agent,', to: 'headers: { accept: "application/json" },' }],
      /connections the address named by the environment received: expected 1 to be \+0/);
  });

  it("mutation_request_goes_to_another_host", () => {
    row("without_an_injected_address_the_one_connection_goes_to_the_npm_registry",
      [
        { file: UPDATE, from: 'export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/orch-os/latest";', to: 'export const REGISTRY_LATEST_URL = "https://registry.invalid/orch-os/latest";' },
      ],
      /default address: connections attempted: expected \[ 'registry\.invalid:443' \] to deeply equal \[ 'registry\.npmjs\.org:443' \]/);
  });

  it("mutation_check_accepts_an_address_option", () => {
    row("update_needs_its_subcommand_and_check_takes_no_argument",
      [{ file: CLI, from: "exit 1 when unavailable\", run: cmdUpdateCheck }]", to: 'exit 1 when unavailable", run: cmdUpdateCheck, opts: [opt("url", ["--url"], "str", "address to ask")] }]' }],
      /orch update check --url http:\/\/127\.0\.0\.1:\d+\/orch-os\/latest: exit code and stdout: expected \[ \+?0, …\(1\) \] to deeply equal \[ 2, '' \]/);
  });

  it("mutation_docs_state_another_deadline", () => {
    row("the_command_reference_names_the_lines_and_limits_the_command_has", [{ file: "docs/commands.md", from: "one deadline of 800 ms", to: "one deadline of 8 s" }],
      /docs\/commands\.md: the deadline: expected .+ to contain 'one deadline of 800 ms'/);
  });
});

describe("UpdateCheckMutationHarness", () => {
  const name = "newer_version_is_offered_on_stdout_with_both_versions_and_exit_0";
  const expected = /newer: stdout: expected/;

  it("invalid_a_runtime_error_in_the_product_is_not_a_kill", () => {
    invalid(name, [{ file: CLI, from: ASK, to: `  if (process.pid > 0) throw new Error("unrelated runtime failure");\n${ASK}` }], expected, "Error: unrelated runtime failure");
  });

  it("invalid_a_source_file_that_does_not_build_is_not_a_kill", () => {
    invalid(name, [{ file: UPDATE, from: "export const DEADLINE_MS = 800;", to: 'export const DEADLINE_MS: number = "not a number";' }], expected, "the changed copy did not build");
  });

  it("invalid_a_test_file_that_does_not_load_is_not_a_kill", () => {
    invalid(name, [{ file: TEST_FILE, from: 'import { helpOf } from "../src/args.js";', to: 'import { helpOf } from "../src/no-such-module.js";' }], expected, "the named test did not run");
  });

  it("invalid_a_child_that_cannot_import_is_not_a_kill", () => {
    invalid(ONE_CONNECTION, [{ file: "tests/update-check-entry.mjs", from: 'import net from "node:net";', to: 'import net from "node:net";\nimport "./no-such-module.mjs";' }],
      /file changes during update check|processes started during update check|connections opened during update check/, "entry child: the report line is complete");
  });

  it("invalid_a_child_that_fails_in_setup_is_not_a_kill", () => {
    invalid(ONE_CONNECTION, [{ file: "tests/update-check-entry.mjs", from: "let code = null;\n", to: 'let code = null;\nif (process.pid > 0) throw new Error("unrelated setup failure");\n' }],
      /file changes during update check|processes started during update check|connections opened during update check/, "unrelated setup failure");
  });

  it("invalid_a_missing_fixture_is_not_a_kill", () => {
    invalid("public_text_manifest_matches_the_docs_and_the_help", [{ file: "tests/fixtures/part2-public-text.json", remove: true }], /sha256 of/, "ENOENT");
  });

  it("the_copy_is_unchanged_after_the_rows", () => {
    const run = runTests();
    expect(run.built, run.raw).toBe(true);
    expect(Object.fromEntries(Object.entries(run.tests).map(([k, v]) => [k, v.status])), "every test passes again in the copy").toEqual(control);
    expect(Object.values(control).every((s) => s === "passed"), `every test passed in the unchanged copy: ${JSON.stringify(control)}`).toBe(true);
  });
});
