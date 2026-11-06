// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch resume` as the package ships it. Every run is the built command line (dist/cli.js) in its own
// process, with a user home, an ORCH_HOME and a working folder made for the test under the system
// temporary folder. The commands are read from docs/resume.md, so the page and the test name the same ones.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIST_CLI, ROOT } from "./_helpers.js";

const HELP_LINE = "  resume       a private continuation note for one workspace: save, show, forget (shown as unverified caller text)";
const DOCUMENTED = [
  "orch resume save --workspace PATH --expected-revision N",
  "orch resume show --workspace PATH",
  "orch resume forget --workspace PATH --expected-revision N",
];
const NOTE = { objective: "Prepare the release", next_step: "Review the diff", reported_progress: "Draft saved" };
const MODULE_ENTRY = join(ROOT, "dist", "resume", "command.js");
/** A config file no command can load: a command that reads it exits 2. */
const BROKEN_CONFIG = "x = [";

type Ran = { status: number | null; stdout: string; stderr: string };
const d = { base: "", user: "", home: "", cwd: "", workspace: "" };

beforeEach(() => {
  d.base = mkdtempSync(join(realpathSync(tmpdir()), "orch-resume-registered-"));
  d.user = join(d.base, "user");
  d.home = join(d.base, "orch-home");
  d.cwd = join(d.base, "cwd");
  d.workspace = join(d.base, "workspace");
  for (const dir of [d.user, d.home, d.cwd, d.workspace]) mkdirSync(dir);
  writeFileSync(join(d.home, "config.toml"), BROKEN_CONFIG);
});
afterEach(() => rmSync(d.base, { recursive: true, force: true, maxRetries: 3 }));

/** `node PROGRAM WORDS` in the test's own folders; `input` is the whole of its standard input. */
function node(program: string, words: string[], input: string): Ran {
  const env = { ...process.env, HOME: d.user, USERPROFILE: d.user, ORCH_HOME: d.home };
  const r = spawnSync(process.execPath, [program, ...words], { cwd: d.cwd, env, input, encoding: "utf8", timeout: 30_000 });
  expect(r.error, `${words.join(" ")}: spawn error`).toBeUndefined();
  expect(r.signal, `${words.join(" ")}: signal\n${r.stderr}`).toBeNull();
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The packaged command: `orch WORDS`. */
const orch = (words: string[], input = ""): Ran => node(DIST_CLI, words, input);

/** The `orch resume` commands docs/resume.md gives, in the order of the page. */
function documented(): string[] {
  const page = readFileSync(join(ROOT, "docs", "resume.md"), "utf8");
  return [...page.matchAll(/`(orch resume [^`]+)`/g)].map((m) => m[1]);
}

/** The words of a documented command after `orch`, with PATH and N filled in. */
function words(command: string, path: string, revision: number): string[] {
  return command.split(" ").slice(1).map((w) => (w === "PATH" ? path : w === "N" ? String(revision) : w));
}

/** What the test's folders hold besides the private note store. */
function leftBehind(): string[][] {
  return [readdirSync(d.cwd), readdirSync(d.workspace), readdirSync(d.home), readdirSync(d.user)];
}

describe("ResumeRegistered", () => {
  it("orch_help_lists_resume_with_its_one_line", () => {
    const r = orch(["--help"]);
    expect([r.status, r.stderr], "orch --help: exit code and stderr").toEqual([0, ""]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  resume ")), "orch --help: the resume line").toEqual([HELP_LINE]);
    expect(r.stdout.split("\n")[0], "orch --help: the usage line names resume").toMatch(/^usage: orch \{[^}]*\bresume\b[^}]*\} \.\.\.$/);
  });

  it("the_commands_of_the_page_save_show_and_forget_one_note", () => {
    expect(documented(), "docs/resume.md: the orch resume commands").toEqual(DOCUMENTED);
    const [save, show, forget] = documented();

    const saved = orch(words(save, d.workspace, 0), JSON.stringify(NOTE));
    expect([saved.status, saved.stderr], `orch resume save: exit code and stderr\n${saved.stdout}`).toEqual([0, ""]);
    expect(JSON.parse(saved.stdout), "orch resume save: result").toMatchObject({ status: "saved", revision: 1 });
    expect(readdirSync(join(d.user, ".orch-private")), "the note store under the user home").toEqual(["resume-v1"]);

    const shown = orch(words(show, d.workspace, 0));
    expect([shown.status, shown.stderr], `orch resume show: exit code and stderr\n${shown.stdout}`).toEqual([0, ""]);
    expect(JSON.parse(shown.stdout), "orch resume show: result").toMatchObject({ status: "unverified", revision: 1, note: NOTE });

    const forgotten = orch(words(forget, d.workspace, 1));
    expect([forgotten.status, forgotten.stderr], `orch resume forget: exit code and stderr\n${forgotten.stdout}`).toEqual([0, ""]);
    expect(JSON.parse(forgotten.stdout), "orch resume forget: result").toMatchObject({ status: "forgotten", revision: 2 });
    const after = orch(words(show, d.workspace, 0));
    const absent = `${JSON.stringify({ status: "absent", revision: 2 })}\n`;
    expect([after.status, after.stdout, after.stderr], "orch resume show after forget").toEqual([0, absent, ""]);

    // nothing in the working folder, the workspace or ORCH_HOME; the config file that cannot be loaded was never read
    expect(leftBehind(), "working folder, workspace, ORCH_HOME and user home afterwards").toEqual([[], [], ["config.toml"], [".orch-private"]]);
    expect(readFileSync(join(d.home, "config.toml"), "utf8"), "the config file").toBe(BROKEN_CONFIG);
  });

  it("a_workspace_given_through_a_link_is_refused_with_status_4_and_nothing_is_created", () => {
    const [, show] = documented();
    const link = join(d.base, "link");
    symlinkSync(d.workspace, link, "dir");
    const r = orch(words(show ?? DOCUMENTED[1], link, 0));
    const refusal = `${JSON.stringify({ status: "unavailable", message: "workspace or home is unavailable" })}\n`;
    expect([r.status, r.stdout, r.stderr], "orch resume show through a link").toEqual([4, "", refusal]);
    expect(existsSync(join(d.user, ".orch-private")), "a note store was created").toBe(false);
    expect(leftBehind(), "working folder, workspace, ORCH_HOME and user home afterwards").toEqual([[], [], ["config.toml"], []]);
  });

  it("the_exit_codes_of_the_command_reference_are_the_ones_the_command_gives", () => {
    const reference = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
    const start = reference.indexOf("## orch resume\n");
    expect(start >= 0, "docs/commands.md has an orch resume section").toBe(true);
    const section = reference.slice(start, reference.indexOf("\n## ", start + 1));
    expect([...section.matchAll(/^\| `(\d)` \|/gm)].map((m) => Number(m[1])), "docs/commands.md: exit codes of orch resume").toEqual([0, 2, 3, 4]);
    expect(section, "docs/commands.md: the section links the page").toContain("[resume.md](resume.md)");
    const [save, show] = DOCUMENTED;

    const none = orch(words(show, d.workspace, 0));
    const absent = `${JSON.stringify({ status: "absent", revision: 0 })}\n`;
    expect([none.status, none.stdout, none.stderr], "show with no note: exit 0").toEqual([0, absent, ""]);
    const typed = "ARGUMENT-CANARY-31";
    const unknown = orch([...words(show, d.workspace, 0), `--${typed}`]);
    expect([unknown.status, unknown.stdout], "an unknown option: exit 2").toEqual([2, ""]);
    expect(JSON.parse(unknown.stderr).status, "an unknown option: status").toBe("invalid");
    expect(unknown.stderr, "an unknown option is not repeated").not.toContain(typed);
    const malformed = orch(words(save, d.workspace, 0), "{");
    expect([malformed.status, malformed.stdout], "a note that is not JSON: exit 2").toEqual([2, ""]);
    expect(orch(words(save, d.workspace, 0), JSON.stringify(NOTE)).status, "first save").toBe(0);
    const stale = orch(words(save, d.workspace, 0), JSON.stringify(NOTE));
    const conflict = `${JSON.stringify({ status: "conflict", message: "revision conflict" })}\n`;
    expect([stale.status, stale.stdout, stale.stderr], "a save with a revision that is not current: exit 3").toEqual([3, "", conflict]);
  });

  it("arguments_output_and_exit_code_are_those_of_the_module_entry", () => {
    const lists = [[], ["--help"], ["save", "--help"], ["-h"], ["bogus"], ["show"], ["show", "--workspace"], ["--", "show"],
      ["show", "--workspace", d.workspace], ["forget", "--workspace", d.workspace, "--expected-revision", "7"],
      ["save", "--workspace", d.workspace, "--expected-revision=x"]];
    for (const list of lists) {
      const direct = node(MODULE_ENTRY, list, "");
      expect(orch(["resume", ...list]), `orch resume ${list.join(" ")}: same as the module entry`).toEqual(direct);
    }
    const help = orch(["resume", "--help"]);
    expect([help.status, help.stdout.split("\n")[0], help.stderr], "orch resume --help").toEqual([0, "usage: resume {save,show,forget} ...", ""]);
  });
});
