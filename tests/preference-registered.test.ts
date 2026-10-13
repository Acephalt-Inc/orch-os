// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch preference` as the package ships it. Every run is the built command line (dist/cli.js) in its own
// process, with a user home, an ORCH_HOME and a working folder made for the test under the system
// temporary folder. The commands are read from the `orch preference` section of docs/commands.md, which
// docs/preferences.md is linked from, so the reference and the test name the same ones.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIST_CLI, ROOT } from "./_helpers.js";

const HELP_LINE = "  preference   personal display preferences for one workspace: set, show, unset (response language, answer length)";
const DOCUMENTED = [
  "orch preference set KEY VALUE --workspace PATH --expected-revision N",
  "orch preference show --workspace PATH",
  "orch preference unset KEY --workspace PATH --expected-revision N",
];
const MODULE_ENTRY = join(ROOT, "dist", "preferences", "command.js");
/** A config file no command can load: a command that reads it exits 2. */
const BROKEN_CONFIG = "x = [";

type Ran = { status: number | null; stdout: string; stderr: string };
type Fill = { key?: string; value?: string; path?: string; revision?: number };
const d = { base: "", user: "", home: "", cwd: "", workspace: "" };

beforeEach(() => {
  d.base = mkdtempSync(join(realpathSync(tmpdir()), "orch-preference-registered-"));
  d.user = join(d.base, "user");
  d.home = join(d.base, "orch-home");
  d.cwd = join(d.base, "cwd");
  d.workspace = join(d.base, "workspace");
  for (const dir of [d.user, d.home, d.cwd, d.workspace]) mkdirSync(dir);
  writeFileSync(join(d.home, "config.toml"), BROKEN_CONFIG);
});
afterEach(() => rmSync(d.base, { recursive: true, force: true, maxRetries: 3 }));

/** `node PROGRAM WORDS` in the test's own folders, with an empty standard input. */
function node(program: string, words: string[]): Ran {
  const env = { ...process.env, HOME: d.user, USERPROFILE: d.user, ORCH_HOME: d.home };
  const r = spawnSync(process.execPath, [program, ...words], { cwd: d.cwd, env, input: "", encoding: "utf8", timeout: 30_000 });
  expect(r.error, `${words.join(" ")}: spawn error`).toBeUndefined();
  expect(r.signal, `${words.join(" ")}: signal\n${r.stderr}`).toBeNull();
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The packaged command: `orch WORDS`. */
const orch = (words: string[]): Ran => node(DIST_CLI, words);

/** The `orch preference` section of docs/commands.md. */
function section(): string {
  const reference = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
  const start = reference.indexOf("## orch preference\n");
  expect(start >= 0, "docs/commands.md has an orch preference section").toBe(true);
  return reference.slice(start, reference.indexOf("\n## ", start + 1));
}

/** The commands the section gives in its usage block, in order. */
function documented(): string[] {
  return (/```text\n([\s\S]*?)\n```/.exec(section())?.[1] ?? "").split("\n");
}

/** The words of a documented command after `orch`, with KEY, VALUE, PATH and N filled in. */
function words(command: string, fill: Fill): string[] {
  const values: Record<string, string> = {
    KEY: fill.key ?? "response-language", VALUE: fill.value ?? "zh", PATH: fill.path ?? d.workspace, N: String(fill.revision ?? 0),
  };
  return command.split(" ").slice(1).map((w) => values[w] ?? w);
}

/** What the test's folders hold. */
function leftBehind(): string[][] {
  return [readdirSync(d.cwd), readdirSync(d.workspace), readdirSync(d.home), readdirSync(d.user)];
}

describe("PreferenceRegistered", () => {
  it("orch_help_lists_preference_with_its_one_line", () => {
    const r = orch(["--help"]);
    expect([r.status, r.stderr], "orch --help: exit code and stderr").toEqual([0, ""]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  preference ")), "orch --help: the preference line").toEqual([HELP_LINE]);
    expect(r.stdout.split("\n")[0], "orch --help: the usage line names preference").toMatch(/^usage: orch \{[^}]*\bpreference\b[^}]*\} \.\.\.$/);
  });

  it("the_commands_of_the_reference_set_show_and_unset_one_setting", () => {
    expect(documented(), "docs/commands.md: the orch preference commands").toEqual(DOCUMENTED);
    expect(section(), "docs/commands.md: the section links the page").toContain("[preferences.md](preferences.md)");
    expect(readFileSync(join(ROOT, "docs", "preferences.md"), "utf8"), "docs/preferences.md names the packaged command").toContain("`orch preference`");
    const [set, show, unset] = documented();

    const changed = orch(words(set, { revision: 0 }));
    expect([changed.status, changed.stderr], `orch preference set: exit code and stderr\n${changed.stdout}`).toEqual([0, ""]);
    const view = { source: "explicit-command", revision: 1, preferences: { "response-language": "zh" } };
    expect(JSON.parse(changed.stdout), "orch preference set: result").toMatchObject(view);
    expect(readdirSync(join(d.user, ".orch-private")), "the settings store under the user home").toEqual(["preferences-v1"]);

    const shown = orch(words(show, {}));
    expect([shown.status, shown.stdout, shown.stderr], "orch preference show: the same view as set printed").toEqual([0, changed.stdout, ""]);

    const removed = orch(words(unset, { revision: 1 }));
    expect([removed.status, removed.stderr], `orch preference unset: exit code and stderr\n${removed.stdout}`).toEqual([0, ""]);
    expect(JSON.parse(removed.stdout), "orch preference unset: result").toEqual({ source: "explicit-command", revision: 2, preferences: {}, expiry: {} });

    // nothing in the working folder, the workspace or ORCH_HOME; the config file that cannot be loaded was never read
    expect(leftBehind(), "working folder, workspace, ORCH_HOME and user home afterwards").toEqual([[], [], ["config.toml"], [".orch-private"]]);
    expect(readFileSync(join(d.home, "config.toml"), "utf8"), "the config file").toBe(BROKEN_CONFIG);
  });

  it("a_workspace_given_through_a_link_is_refused_with_status_4_and_nothing_is_created", () => {
    const link = join(d.base, "link");
    symlinkSync(d.workspace, link, "dir");
    const r = orch(words(DOCUMENTED[1], { path: link }));
    const refusal = `${JSON.stringify({ status: "unavailable", message: "unsafe workspace path" })}\n`;
    expect([r.status, r.stdout, r.stderr], "orch preference show through a link").toEqual([4, "", refusal]);
    expect(existsSync(join(d.user, ".orch-private")), "a settings store was created").toBe(false);
    expect(leftBehind(), "working folder, workspace, ORCH_HOME and user home afterwards").toEqual([[], [], ["config.toml"], []]);
  });

  it("the_exit_codes_of_the_command_reference_are_the_ones_the_command_gives", () => {
    expect([...section().matchAll(/^\| `(\d)` \|/gm)].map((m) => Number(m[1])), "docs/commands.md: exit codes of orch preference").toEqual([0, 2, 3, 4]);
    const [set, show] = DOCUMENTED;

    const empty = orch(words(show, {}));
    const none = `${JSON.stringify({ source: "explicit-command", revision: 0, preferences: {}, expiry: {} })}\n`;
    expect([empty.status, empty.stdout, empty.stderr], "show with nothing set: exit 0").toEqual([0, none, ""]);
    const typed = "ARGUMENT-CANARY-32";
    const unknown = orch([...words(show, {}), `--${typed}`]);
    expect([unknown.status, unknown.stdout], "an unknown option: exit 2").toEqual([2, ""]);
    expect(JSON.parse(unknown.stderr).status, "an unknown option: status").toBe("invalid");
    expect(unknown.stderr, "an unknown option is not repeated").not.toContain(typed);
    const invalid = `${JSON.stringify({ status: "invalid", message: "invalid preference key or value" })}\n`;
    for (const fill of [{ key: "answer-length", value: "long" }, { key: "tone", value: "short" }]) {
      const r = orch(words(set, fill));
      expect([r.status, r.stdout, r.stderr], `set ${fill.key} ${fill.value}: exit 2`).toEqual([2, "", invalid]);
    }
    expect(existsSync(join(d.user, ".orch-private", "preferences-v1")), "a refused set wrote a settings store").toBe(false);
    expect(orch(words(set, { key: "answer-length", value: "short", revision: 0 })).status, "first set").toBe(0);
    const stale = orch(words(set, { key: "answer-length", value: "normal", revision: 0 }));
    const conflict = `${JSON.stringify({ status: "conflict", message: "preference revision conflict" })}\n`;
    expect([stale.status, stale.stdout, stale.stderr], "a set with a revision that is not current: exit 3").toEqual([3, "", conflict]);
  });

  it("arguments_output_and_exit_code_are_those_of_the_module_entry", () => {
    const lists = [[], ["--help"], ["set", "--help"], ["-h"], ["bogus"], ["show"], ["show", "--workspace"], ["--", "show"],
      ["show", "--workspace", d.workspace], ["preference", "show", "--workspace", d.workspace],
      ["unset", "tone", "--workspace", d.workspace, "--expected-revision", "0"],
      ["set", "answer-length", "short", "--workspace", d.workspace, "--expected-revision=x"]];
    for (const list of lists) {
      const direct = node(MODULE_ENTRY, list);
      expect(orch(["preference", ...list]), `orch preference ${list.join(" ")}: same as the module entry`).toEqual(direct);
    }
    const help = orch(["preference", "--help"]);
    expect([help.status, help.stdout.split("\n")[0], help.stderr], "orch preference --help").toEqual([0, "usage: preference {set,show,unset} ...", ""]);
  });
});
