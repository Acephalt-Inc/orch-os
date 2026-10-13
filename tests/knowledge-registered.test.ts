// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch knowledge` as the package ships it. Every run is the built command line (dist/cli.js) in its own
// process, with a user home, an ORCH_HOME and a working folder made for the test under the system
// temporary folder, and no environment but theirs. The commands are read from docs/knowledge.md, so the
// page and the test name the same ones. Runs marked `probe` are started under fixtures/knowledge/probe.mjs,
// which pins the clock and reports every file, network and process call.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Canary, canary, type Child, ENTRY, errorLine, EXPECTED, ISO_TIME, node, okLine, type ProbeCall, ROOT, sandbox,
} from "./fixtures/knowledge/harness.js";

const CLI = join(ROOT, "dist", "cli.js");
const HELP_LINE = "  knowledge    synthetic demo; no service connected: looks up one fixed question in the built-in corpus";
const WORDING = "Synthetic demo; no service connected.";
const DOCUMENTED = [
  "orch knowledge query --connection demo --question-id invoice-terms",
  "orch knowledge query --connection demo --question-id approval-threshold",
];
const USAGE = errorLine("USAGE");
/** A config file no command can load: a command that reads it exits 2. */
const BROKEN_CONFIG = "x = [";

const DIST = join(ROOT, "dist") + sep;
const PACKAGE_JSON = join(ROOT, "package.json");
/** The folder of bundled fixtures, as the command line names it when it lists them for its help text. */
const FIXTURES = join(ROOT, "fixtures") + sep;
/** Calls that only read: what Node does to load a file, and listing a folder. */
const READS = ["fs.realpathSync", "fs.readFileSync", "fs.openSync", "fs.readSync", "fs.closeSync", "fs.readdirSync"];

/** Probe calls that are not a read of the package's own files: any network or process call, any write, any other path. */
function outside(calls: ProbeCall[]): ProbeCall[] {
  return calls.filter((c) => {
    const own = c.target.startsWith(DIST) || c.target === PACKAGE_JSON || c.target === FIXTURES;
    if (c.kind !== "file" || !READS.includes(c.name) || !own) return true;
    return c.name === "fs.openSync" && c.detail !== "r";
  });
}

/** A user home with a note store and an ORCH_HOME whose config cannot be loaded, and a working folder. */
function world(base: string, tag: string): Canary {
  const c = canary(base, tag);
  writeFileSync(join(c.env.ORCH_HOME, "config.toml"), BROKEN_CONFIG);
  return c;
}

/** Every entry below a folder with its bytes, so a file that was added, removed or changed shows. */
function snapshot(root: string, relative = ""): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((e) => {
    const path = join(relative, e.name);
    return e.isDirectory() ? [`${path}/`, ...snapshot(root, path)] : [`${path} ${readFileSync(join(root, path)).toString("hex")}`];
  }).sort();
}

/** The packaged command: `orch WORDS` in the world `c`. */
const orch = (c: Canary, words: string[], probe = false): Promise<Child> => node([CLI, ...words], { cwd: c.cwd, env: c.env, probe });

/** The `orch knowledge` commands docs/knowledge.md gives in its shell block, in order. */
function documented(): string[] {
  const page = readFileSync(join(ROOT, "docs", "knowledge.md"), "utf8");
  return (/```sh\n([\s\S]*?)\n```/.exec(page)?.[1] ?? "").split("\n");
}

async function inWorld<T>(f: (base: string) => Promise<T>): Promise<T> {
  const base = sandbox();
  try {
    return await f(base);
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

describe("KnowledgeRegistered", () => {
  it("orch_help_lists_knowledge_as_a_synthetic_demo_with_no_service_connected", () => inWorld(async (base) => {
    const r = await orch(world(base, "A"), ["--help"]);
    expect([r.code, r.signal, r.stderr], "orch --help: exit code and stderr").toEqual([0, null, ""]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  knowledge ")), "orch --help: the knowledge line").toEqual([HELP_LINE]);
    expect(r.stdout.split("\n")[0], "orch --help: the usage line names knowledge").toMatch(/^usage: orch \{[^}]*\bknowledge\b[^}]*\} \.\.\.$/);
  }));

  it("the_commands_of_the_page_print_the_stored_passage_with_its_citation", () => inWorld(async (base) => {
    expect(documented(), "docs/knowledge.md: the orch knowledge commands").toEqual(DOCUMENTED);
    const c = world(base, "A");
    const before = snapshot(base);
    for (const command of documented()) {
      const id = command.split(" ").at(-1)!;
      const oracle = EXPECTED[id];
      const r = await orch(c, command.split(" ").slice(1));
      expect([r.code, r.signal, r.stderr], `${command}: exit code and stderr\n${r.stdout}`).toEqual([0, null, ""]);
      expect(r.stdout.endsWith("\n") && r.stdout.trimEnd().split("\n").length === 1, `${command}: one line`).toBe(true);
      expect(JSON.parse(r.stdout), `${command}: result`).toEqual({
        status: "OK",
        mode: "synthetic",
        question_id: id,
        answer: oracle.answer,
        citation: {
          document_id: oracle.document_id,
          revision: oracle.revision,
          fragment: oracle.fragment,
          sha256: oracle.sha256,
          retrieved_at: expect.stringMatching(ISO_TIME),
          checked_at: expect.stringMatching(ISO_TIME),
        },
      });
    }
    // the config file that cannot be loaded was never read, and nothing was written anywhere in the test's folders
    expect(snapshot(base), "the test's folders afterwards").toEqual(before);
  }));

  it("arguments_that_are_not_the_documented_ones_are_refused_with_exit_2_and_the_fixed_usage_line", () => inWorld(async (base) => {
    const c = world(base, "A");
    const typed = "ARGUMENT-CANARY-33";
    const refused = [
      ["query", "--connection", "demo", "--question-id", typed],
      ["query", "--connection", typed, "--question-id", "invoice-terms"],
      ["query", "--connection", "demo"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--question-id", "invoice-terms"],
      [typed],
      [],
    ];
    for (const words of refused) {
      const r = await orch(c, ["knowledge", ...words]);
      expect([r.code, r.signal, r.stdout, r.stderr], `orch knowledge ${words.join(" ")}`).toEqual([2, null, "", USAGE]);
    }
    // the command reference gives the same line for exit 2, names the three exit codes and links the page
    const reference = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
    const start = reference.indexOf("## orch knowledge\n");
    expect(start >= 0, "docs/commands.md has an orch knowledge section").toBe(true);
    const section = reference.slice(start, reference.indexOf("\n## ", start + 1));
    expect([...section.matchAll(/^\| `(\d)` \|/gm)].map((m) => Number(m[1])), "docs/commands.md: exit codes of orch knowledge").toEqual([0, 1, 2]);
    expect(section, "docs/commands.md: the usage line of exit 2").toContain(`\`${USAGE.trim()}\``);
    expect(section, "docs/commands.md: the section links the page").toContain("[knowledge.md](knowledge.md)");
    expect(section, "docs/commands.md: the section says what the demo is").toContain("A synthetic demo; no service is connected.");
  }));

  it("arguments_output_and_exit_code_are_those_of_the_module_entry", () => inWorld(async (base) => {
    const c = world(base, "A");
    const lists = [[], ["--help"], ["query", "--help"], ["-h"], ["bogus"], ["query"], ["--", "query"],
      ["query", "--connection=demo", "--question-id=x"], ...DOCUMENTED.map((command) => command.split(" ").slice(2))];
    for (const list of lists) {
      const direct = await node([ENTRY, ...list], { cwd: c.cwd, env: c.env, probe: true });
      const packaged = await orch(c, ["knowledge", ...list], true);
      const result = (r: Child) => [r.code, r.signal, r.stdout, r.stderr];
      expect(result(packaged), `orch knowledge ${list.join(" ")}: same as the module entry at the same clock`).toEqual(result(direct));
    }
    const help = await orch(c, ["knowledge", "--help"]);
    expect([help.code, help.stdout.split("\n")[0], help.stderr], "orch knowledge --help").toEqual([0, "usage: knowledge {query} ...", ""]);
    expect(help.stdout, "orch knowledge --help: the wording").toContain(WORDING);
  }));

  it("the_packaged_command_reads_only_files_of_its_own_package_and_gives_one_result_in_two_worlds", () => inWorld(async (base) => {
    const a = world(base, "A");
    const b = world(base, "B");
    const before = snapshot(base);
    const words = DOCUMENTED[0].split(" ").slice(1);
    const first = await orch(a, words, true);
    const second = await orch(b, words, true);
    // byte-identical results under two homes, two ORCH_HOME folders, two working folders and two environments
    expect([first.code, first.signal, first.stdout, first.stderr], "first world").toEqual([0, null, okLine("invoice-terms"), ""]);
    expect([second.code, second.signal, second.stdout, second.stderr], "second world").toEqual([0, null, first.stdout, ""]);
    // nothing but reads of the package's own files: no other open, no write, no network, no process
    expect(outside(first.calls), "first world: calls that are not reads of the package's own files").toEqual([]);
    expect(outside(second.calls), "second world: calls that are not reads of the package's own files").toEqual([]);
    // and the probe was live. Besides its compiled files the command line read two things of the package:
    // its package.json, for the version, and the list of bundled fixtures, for a help text
    expect(first.calls.filter((c) => !c.target.startsWith(DIST)), "calls on paths other than the compiled files").toEqual([
      { kind: "file", name: "fs.readFileSync", target: PACKAGE_JSON, detail: null },
      { kind: "file", name: "fs.readdirSync", target: FIXTURES, detail: null },
    ]);
    expect(second.calls, "the same calls in both worlds").toEqual(first.calls);
    expect(snapshot(base), "the test's folders afterwards").toEqual(before);
  }));
});
