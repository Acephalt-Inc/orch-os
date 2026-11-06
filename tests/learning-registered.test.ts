// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch learning` as the package ships it. Every run is the built command line (dist/cli.js) in its own
// process, with a user home, an ORCH_HOME and a working folder made for the test under the system
// temporary folder, and no environment of the person running the tests. The commands are read from
// docs/learning.md, so the page and the test name the same ones. Most runs are started under
// fixtures/learning/probe.mjs, which freezes the clock and records every file, process, network, home
// and environment call the program makes.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  childEnv, DIST, ENTRY, errorLine, INPUT, inside, MAX_BYTES, NOW, PROBE_URL, type ProbeRecord, REJECTED, REVIEWED, scratch,
  SETTING_ID, SHOWN,
} from "./fixtures/learning/harness.js";

const CLI = join(DIST, "cli.js");
const ROOT = join(DIST, "..");
const HELP_LINE = "  learning     drafts only; nothing is applied: review, show, reject proposed display settings and quoted notes";
const DISPLAY_NOTE = "Proposed display settings and quoted notes only; current instructions take precedence; nothing has been applied.";
const DOCUMENTED = [
  "orch learning review < private-input.json",
  "orch learning show < private-drafts.json",
  "orch learning reject ID --expected-revision 1 < private-drafts.json",
];
/** What the two file names of the page stand for here: the fixture input, and what `review` prints for it. */
const DOCUMENTS: Record<string, Uint8Array | string> = { "private-input.json": INPUT, "private-drafts.json": REVIEWED };
/** A config file no command can load: a command that reads it exits 2. */
const BROKEN_CONFIG = "x = [";
/** The command's own wait for its input, and what starting a process on a busy machine may add. */
const INPUT_WAIT_MS = 4500;
const SCHEDULING_TOLERANCE_MS = 2000;

type World = { home: string; store: string; cwd: string };
type Ran = { status: number | null; signal: string | null; stdout: string; stderr: string };
type Probed = Ran & { record: ProbeRecord };

/** A user home, an ORCH_HOME whose config cannot be loaded and a working folder, each holding a canary file. */
function world(tag: string): World {
  const w = { home: scratch(), store: scratch(), cwd: scratch() };
  writeFileSync(join(w.store, "config.toml"), BROKEN_CONFIG);
  for (const dir of [w.home, w.cwd]) writeFileSync(join(dir, "preferences.json"), `{"answer-length":"normal","canary":"canary-${tag}"}\n`);
  return w;
}

/** The names and bytes of what the three folders of a world hold. */
function contents(w: World): string[] {
  return [w.home, w.store, w.cwd].flatMap((dir) => readdirSync(dir).sort().map((name) => `${name} ${readFileSync(join(dir, name), "hex")}`));
}

const environment = (w: World, tag: string) => childEnv(w.home, { ORCH_HOME: w.store, HOST_MEMORY_NOTE: `canary-${tag} from host memory` });

/** `node PROGRAM WORDS` in the world `w` with `stdin` as its whole standard input, under the probe, at the fixed clock. */
function probed(program: string, words: string[], stdin: Uint8Array | string, w: World, tag = "A"): Probed {
  const env = { ...environment(w, tag), LEARNING_PROBE_NOW: NOW };
  const r = spawnSync(process.execPath, ["--import", PROBE_URL, program, ...words], {
    input: stdin, encoding: "utf8", env, cwd: w.cwd, stdio: ["pipe", "pipe", "pipe", "pipe"], timeout: 55_000, killSignal: "SIGKILL",
  });
  // an empty or broken report fails here: a run without a record proves nothing
  const record: ProbeRecord = JSON.parse(String(r.output[3]));
  expect(record.probe, "the probe wrote its record").toBe("learning-probe");
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, record };
}

/** The packaged command: `orch WORDS`. */
const orch = (words: string[], stdin: Uint8Array | string, w: World, tag = "A"): Probed => probed(CLI, words, stdin, w, tag);
const result = (r: Ran) => [r.status, r.signal, r.stdout, r.stderr];
/** The input document followed by spaces up to `bytes` bytes: still a valid document. */
const padded = (bytes: number) => Buffer.concat([INPUT, Buffer.alloc(bytes - INPUT.length, " ")]);

/** `orch WORDS` with a standard input that is written to and never closed; killed at `hardDeadlineMs` if still alive. */
function orchWithOpenStdin(words: string[], written: Uint8Array | null, hardDeadlineMs: number): Promise<Ran & { killedByTest: boolean; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const w = world("open");
    const child = spawn(process.execPath, [CLI, ...words], { stdio: ["pipe", "pipe", "pipe"], env: environment(w, "open"), cwd: w.cwd });
    const got = { status: null as number | null, signal: null as string | null, stdout: "", stderr: "", killedByTest: false, ms: 0 };
    child.stdout.on("data", (d) => (got.stdout += d));
    child.stderr.on("data", (d) => (got.stderr += d));
    child.stdin.on("error", () => {});
    if (written) child.stdin.write(written);
    const killer = setTimeout(() => {
      got.killedByTest = true;
      child.kill("SIGKILL");
    }, hardDeadlineMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      got.ms = Date.now() - started;
      got.status = code;
      got.signal = signal;
      child.stdin.destroy();
      resolve(got);
    });
  });
}

/** The `orch learning` commands docs/learning.md gives, in the order of the page. */
function documented(): string[] {
  const page = readFileSync(join(ROOT, "docs", "learning.md"), "utf8");
  return [...page.matchAll(/`(orch learning [^`]*<[^`]+)`/g)].map((m) => m[1]);
}

/** A documented command as the words after `orch` and the document its `< FILE` stands for; ID is filled in. */
function parts(command: string): { words: string[]; stdin: Uint8Array | string } {
  const [left, file] = command.split(" < ");
  return { words: left.split(" ").slice(1).map((w) => (w === "ID" ? SETTING_ID : w)), stdin: DOCUMENTS[file] };
}

/** The `orch learning` section of docs/commands.md. */
function section(): string {
  const reference = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
  const start = reference.indexOf("## orch learning\n");
  expect(start >= 0, "docs/commands.md has an orch learning section").toBe(true);
  return reference.slice(start, reference.indexOf("\n## ", start + 1));
}

describe("LearningRegistered", () => {
  it("orch_help_lists_learning_as_drafts_only_with_nothing_applied", () => {
    const r = orch(["--help"], "", world("A"));
    expect([r.status, r.signal, r.stderr], "orch --help: exit code and stderr").toEqual([0, null, ""]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  learning ")), "orch --help: the learning line").toEqual([HELP_LINE]);
    expect(r.stdout.split("\n")[0], "orch --help: the usage line names learning").toMatch(/^usage: orch \{[^}]*\blearning\b[^}]*\} \.\.\.$/);
  });

  it("the_commands_of_the_page_review_show_and_reject_drafts_and_apply_nothing", () => {
    expect(documented(), "docs/learning.md: the orch learning commands").toEqual(DOCUMENTED);
    const w = world("A");
    const before = contents(w);
    const [review, show, reject] = documented().map(parts);
    expect(result(orch(review.words, review.stdin, w)), "orch learning review").toEqual([0, null, REVIEWED, ""]);
    expect(result(orch(show.words, show.stdin, w)), "orch learning show").toEqual([0, null, SHOWN, ""]);
    expect(result(orch(reject.words, reject.stdin, w)), "orch learning reject").toEqual([0, null, REJECTED, ""]);
    // the config file that cannot be loaded was never read, and nothing was written: no file is created, no setting applied
    expect(contents(w), "the user home, ORCH_HOME and the working folder afterwards").toEqual(before);
  });

  it("the_exit_codes_of_the_command_reference_are_the_ones_the_command_gives", () => {
    expect([...section().matchAll(/^\| `(\d)` \|/gm)].map((m) => Number(m[1])), "docs/commands.md: exit codes of orch learning").toEqual([0, 1, 2]);
    expect(section(), "docs/commands.md: the section links the page").toContain("[learning.md](learning.md)");
    expect(section(), "docs/commands.md: the section says nothing is applied").toContain("Drafts only; nothing is applied");
    const w = world("A");
    const stale = orch(["learning", "reject", SETTING_ID, "--expected-revision", "9"], REVIEWED, w);
    expect(result(stale), "reject with a revision that is not the document's: exit 1").toEqual([1, null, "", errorLine("CONFLICT")]);
    const missing = orch(["learning", "reject", "0".repeat(64), "--expected-revision", "1"], REVIEWED, w);
    expect(result(missing), "reject of an ID that is not a draft: exit 1").toEqual([1, null, "", errorLine("NOT_FOUND")]);
    const atCap = orch(["learning", "review"], padded(MAX_BYTES), w);
    expect(result(atCap), "a valid document of exactly the cap: exit 0").toEqual([0, null, REVIEWED, ""]);
    const large = orch(["learning", "review"], "x".repeat(MAX_BYTES + 1), w);
    expect(result(large), "an input over the cap: exit 1").toEqual([1, null, "", errorLine("LIMIT")]);
    const typed = "ARGUMENT-CANARY-34";
    for (const words of [["apply"], ["review", `--${typed}`], ["reject", SETTING_ID], [typed], []]) {
      const r = orch(["learning", ...words], REVIEWED, w);
      expect(result(r), `orch learning ${words.join(" ")}: exit 2`).toEqual([2, null, "", errorLine("USAGE")]);
    }
    const broken = orch(["learning", "review"], `{"note":"${typed}"`, w);
    expect(result(broken), "an input that is not a document: exit 2").toEqual([2, null, "", errorLine("INVALID_INPUT")]);
  });

  it("an_input_that_is_never_closed_ends_with_timeout_and_an_oversized_one_with_limit", async () => {
    // The two readers wait the same time. The constants are read from the source, because a wait
    // that differs by less than the scheduling tolerance below could not be told apart by timing.
    expect(readFileSync(join(ROOT, "src", "cli.ts"), "utf8"), "src/cli.ts: the wait of orch learning").toContain(
      `const LEARNING_STDIN_DEADLINE_MS = ${INPUT_WAIT_MS};`);
    expect(readFileSync(join(ROOT, "src", "learning", "entry.ts"), "utf8"), "src/learning/entry.ts: the wait of the module entry").toContain(
      `const STDIN_DEADLINE_MS = ${INPUT_WAIT_MS};`);
    const hard = INPUT_WAIT_MS + SCHEDULING_TOLERANCE_MS + 3000;
    const [open, half, over, help] = await Promise.all([
      orchWithOpenStdin(["learning", "review"], null, hard),
      orchWithOpenStdin(["learning", "show"], Buffer.from(REVIEWED.slice(0, 40)), hard),
      orchWithOpenStdin(["learning", "review"], Buffer.alloc(MAX_BYTES + 1, 0x20), hard),
      orchWithOpenStdin(["learning", "--help"], null, hard),
    ]);
    for (const [label, r] of [["nothing sent", open], ["half a document sent", half]] as const) {
      expect([r.status, r.signal, r.stdout, r.stderr, r.killedByTest], `${label}, input left open`).toEqual([1, null, "", errorLine("TIMEOUT"), false]);
      expect(r.ms >= INPUT_WAIT_MS - 100 && r.ms < INPUT_WAIT_MS + SCHEDULING_TOLERANCE_MS, `${label}: ended ${r.ms} ms after its start`).toBe(true);
    }
    expect([over.status, over.signal, over.stdout, over.stderr, over.killedByTest], "more than the cap sent, input left open").toEqual(
      [1, null, "", errorLine("LIMIT"), false]);
    expect(over.ms < INPUT_WAIT_MS, `more than the cap: ended ${over.ms} ms after its start, before the wait was over`).toBe(true);
    // help never reads the input, so it does not wait for it
    expect([help.status, help.signal, help.stderr, help.killedByTest], "help with the input left open").toEqual([0, null, "", false]);
    expect(help.stdout, "orch learning --help: the sentence the page quotes").toContain(DISPLAY_NOTE);
    expect(help.ms < INPUT_WAIT_MS, `help: ended ${help.ms} ms after its start, before the wait was over`).toBe(true);
  }, 30_000);

  it("arguments_input_output_and_exit_code_are_those_of_the_module_entry", () => {
    const w = world("A");
    const runs: [string[], Uint8Array | string][] = [
      [[], ""], [["--help"], ""], [["review", "--help"], ""], [["-h"], ""], [["bogus"], ""], [["--", "review"], INPUT],
      [["review"], INPUT], [["review"], REVIEWED], [["show"], REVIEWED], [["show"], INPUT], [["review"], "{"], [["review"], ""],
      [["reject", SETTING_ID, "--expected-revision", "1"], REVIEWED], [["reject", SETTING_ID, "--expected-revision=9"], REVIEWED],
      [["reject", SETTING_ID, "--expected-revision", "1", "--expected-revision", "1"], REVIEWED],
      [["review"], "x".repeat(MAX_BYTES + 1)], [["review"], padded(MAX_BYTES)],
    ];
    for (const [words, stdin] of runs) {
      const direct = probed(ENTRY, words, stdin, w);
      expect(result(orch(["learning", ...words], stdin, w)), `orch learning ${words.join(" ")}: same as the module entry at the same clock`).toEqual(
        result(direct));
    }
    const help = orch(["learning", "--help"], "", w);
    expect([help.status, help.stdout.split("\n")[0], help.stderr], "orch learning --help").toEqual([0, "usage: learning {review,show,reject} ...", ""]);
  });

  it("the_packaged_command_reads_no_environment_no_home_and_no_file_but_its_own_and_gives_one_result_in_two_worlds", () => {
    const a = world("A");
    const b = world("B");
    const before = [contents(a), contents(b)];
    const first = orch(["learning", "review"], INPUT, a, "A");
    const second = orch(["learning", "review"], INPUT, b, "B");
    // byte-identical results under two homes, two ORCH_HOME folders, two working folders and two environments
    expect(result(first), "first world").toEqual([0, null, REVIEWED, ""]);
    expect(result(second), "second world").toEqual([0, null, REVIEWED, ""]);
    // what the command line does before it runs any command: `orch --help` runs none
    const idle = orch(["--help"], "", a, "A").record;
    const count = (record: ProbeRecord, name: string) => record.fs_read.filter((n) => n === name).length;
    for (const [label, record] of [["first world", first.record], ["second world", second.record]] as const) {
      const effects = [record.fs_write, record.process, record.network, record.home, record.env];
      expect(effects, `${label}: file writes, process starts, network calls, home lookups and environment reads`).toEqual([[], [], [], [], []]);
      // the runtime loaded compiled files of the package and nothing else
      expect(record.runtime.loaded.filter((p) => !inside(DIST, p)), `${label}: files loaded from outside the program`).toEqual([]);
      // the program's own reads are those of the command line itself: its package.json for the version and the list
      // of bundled fixtures for a help text, both also made by `orch --help`; the rest resolves its own module paths
      expect([...new Set(record.fs_read)].sort(), `${label}: kinds of file read`).toEqual(["fs.readFileSync", "fs.readdirSync", "fs.realpathSync"]);
      expect([count(record, "fs.readFileSync"), count(record, "fs.readdirSync")], `${label}: file and folder reads, as many as orch --help makes`).toEqual(
        [count(idle, "fs.readFileSync"), count(idle, "fs.readdirSync")]);
      expect([count(idle, "fs.readFileSync"), count(idle, "fs.readdirSync")], "orch --help: one file read and one folder listing").toEqual([1, 1]);
    }
    expect([contents(a), contents(b)], "both worlds afterwards").toEqual(before);
  });
});
