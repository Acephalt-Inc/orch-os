// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The "Network services" line of docs/architecture.md, checked against the built command line.
//
// Every command the line names is run from dist/cli.js with a stand-in `gh` first on PATH
// (tests/fixtures/fake-gh.mjs) that logs its arguments, and with stand-in programs for the
// reviewer command, the worker command and `temp_command`. Commands the line does not name are
// run the same way under tests/update-check-entry.mjs, which records every connection attempt
// and never opens one to anything but 127.0.0.1. No test here reaches a real network.
//
// `review watch` and `worker start` are refused on Windows, and `load` does not run
// `temp_command` there; the tests assert that instead of the calls.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTree } from "../src/cli.js";
import { DIST_CLI, fakeNodeBin, ROOT, testPath, waitFor, WINDOWS } from "./_helpers.js";

const ENTRY = join(ROOT, "tests", "update-check-entry.mjs");
/** The head commit the stand-in `gh` reports. */
const HEAD = "4f2c9a1e7b3d5c8a9e0f1b2c3d4e5f6a7b8c9d0e";
const REPO = "acme/widgets";
/** The commands the line names (`orch update check` as `update check`). Each has a test below. */
const NAMED = ["load", "merge-gate", "review approve", "review changes", "review reject", "review watch", "update check", "worker start"];

const PR_VIEW_GATE = ["pr", "view", "7", "--repo", REPO, "--json", "author,headRefOid,reviews,labels,statusCheckRollup"];
const PR_VIEW_HEAD = ["pr", "view", "7", "--repo", REPO, "--json", "headRefOid"];
const PR_VIEW_WATCH = ["pr", "view", "7", "--repo", REPO, "--json", "headRefOid,state,comments"];
const API_WATCH = [`repos/${REPO}/commits/${HEAD}/check-runs`, `repos/${REPO}/commits/${HEAD}/status`, `repos/${REPO}/actions/runs?head_sha=${HEAD}&per_page=100`];
const comment = (body: string) => ["pr", "comment", "7", "--repo", REPO, "--body", body];

/** A `gh` call that only reads: `pr view`, or `api` without a method, a field or an input. */
const isRead = (call: string[]) => (call[0] === "pr" && call[1] === "view")
  || (call[0] === "api" && !call.some((a) => ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"].includes(a)));

/** The one "Network services" line of docs/architecture.md. */
function networkLine(): string {
  const lines = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8").split("\n").filter((l) => l.startsWith("- **Network services.**"));
  expect(lines.length, "docs/architecture.md: lines that start with - **Network services.**").toBe(1);
  return lines[0];
}

/** The commands a line names: every `code` span that starts with a command of `orch`, without a leading `orch `. */
function commandsNamed(line: string): string[] {
  const top = buildTree().sub!.map((c) => c.name);
  const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/^orch /, ""));
  return spans.filter((s) => top.includes(s.split(" ")[0])).sort();
}

type Ran = { status: number | null; stdout: string; stderr: string };
const d = { base: "", bin: "", home: "", user: "", ghLog: "", programLog: "" };

/** A stand-in program: it appends `TAG ARGUMENTS` to the file named by FAKE_PROGRAM_LOG and prints `prints`. */
const program = (tag: string, prints = "") => `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_PROGRAM_LOG, [${JSON.stringify(tag)}, ...process.argv.slice(2)].join(" ") + "\\n");
process.stdout.write(${JSON.stringify(prints)});
`;

beforeEach(() => {
  d.base = mkdtempSync(join(realpathSync(tmpdir()), "orch-net-"));
  d.bin = join(d.base, "bin");
  d.home = join(d.base, "orch-home");
  d.user = join(d.base, "user");
  d.ghLog = join(d.base, "gh.log");
  d.programLog = join(d.base, "programs.log");
  for (const dir of [d.bin, d.user]) mkdirSync(dir);
  fakeNodeBin(d.bin, "gh", readFileSync(join(ROOT, "tests", "fixtures", "fake-gh.mjs"), "utf8"));
  fakeNodeBin(d.bin, "fake-reviewer", program("reviewer"));
  fakeNodeBin(d.bin, "fake-worker", program("worker"));
  fakeNodeBin(d.bin, "fake-probe", program("probe", "41.5\n"));
});
afterEach(() => rmSync(d.base, { recursive: true, force: true, maxRetries: 3 }));

/** The environment of every command: the stand-ins first on PATH, and a home and a user folder inside the test's own folder. */
function environment(): NodeJS.ProcessEnv {
  const set: Record<string, string> = {
    PATH: testPath(d.bin), HOME: d.user, USERPROFILE: d.user, ORCH_HOME: d.home, ORCH_AGENT_DIRS: "",
    FAKE_GH_LOG: d.ghLog, FAKE_PROGRAM_LOG: d.programLog,
  };
  const dropped = [...Object.keys(set), "ORCH_AGENT", "ORCH_SESSION_ID"];
  // names are compared without case: Windows may spell PATH as Path
  const kept = Object.entries(process.env).filter(([k]) => !dropped.includes(k.toUpperCase()) && !/^VITEST/i.test(k));
  return { ...Object.fromEntries(kept), ...set };
}

/** `node dist/cli.js ARGUMENTS`. */
function orch(...argv: string[]): Ran {
  const r = spawnSync(process.execPath, [DIST_CLI, ...argv], { cwd: d.base, env: environment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  expect(r.error, `orch ${argv.join(" ")}: spawn error`).toBeUndefined();
  expect(r.signal, `orch ${argv.join(" ")}: signal\n${r.stderr}`).toBeNull();
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The same command under the entry that records connection attempts; `connections` lists them as host:port. */
function observed(...argv: string[]): Ran & { connections: string[] } {
  const r = spawnSync(process.execPath, [ENTRY, DIST_CLI, "-", ...argv], {
    cwd: d.base, env: environment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 30_000,
  });
  expect(r.error, `observed orch ${argv.join(" ")}: spawn error`).toBeUndefined();
  expect(r.signal, `observed orch ${argv.join(" ")}: signal\n${r.stderr}`).toBeNull();
  const report = JSON.parse(String(r.output[3]));
  expect(report.failure, `observed orch ${argv.join(" ")}: main() threw`).toBeNull();
  expect(report.code, `observed orch ${argv.join(" ")}: main() returned the exit code`).toBe(r.status);
  const connections = (report.ops as { kind: string; target: string }[]).filter((o) => o.kind === "connect").map((o) => o.target);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, connections };
}

/** The calls the stand-in `gh` has logged since the last time this was asked. */
function ghCalls(): string[][] {
  if (!existsSync(d.ghLog)) return [];
  const calls = readFileSync(d.ghLog, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
  rmSync(d.ghLog);
  return calls;
}

/** The lines the stand-in programs have logged so far. */
const programLines = (): string[] => (existsSync(d.programLog) ? readFileSync(d.programLog, "utf8").split("\n").filter((l) => l !== "") : []);

/** A config with a repository, one reviewer, a worker command and a temperature command. */
function configure(): void {
  mkdirSync(d.home, { recursive: true });
  writeFileSync(join(d.home, "config.toml"), `[merge]\nrepo = "${REPO}"\n[review.agents.reviewer]\ncmd = ["fake-reviewer", "{pr}"]\n`
    + `[workers]\ncommand = ["fake-worker", "configured"]\n[load]\ntemp_command = "fake-probe"\n`);
}

describe("NetworkSentence", () => {
  it("the_network_services_line_names_exactly_the_commands_that_call_out_or_start_a_program", () => {
    const line = networkLine();
    expect(commandsNamed(line), "docs/architecture.md: commands the Network services line names").toEqual(NAMED);
    expect(line, "docs/architecture.md: the Network services line says only").not.toMatch(/\bonly\b/i);
    expect(line, "docs/architecture.md: the Network services line says nothing listens").toContain("Nothing listens on a port.");
  });

  it("live_merge_gate_reads_the_pull_request_through_gh_and_a_fixture_run_starts_no_gh", () => {
    const live = orch("merge-gate", "7", "--repo", REPO);
    expect([live.status, live.stdout.trim().split("\n").at(-1), live.stderr], "live merge-gate: result").toEqual([0, "=> PASS", ""]);
    const calls = ghCalls();
    expect(calls, "live merge-gate: gh calls").toEqual([PR_VIEW_GATE]);
    expect(calls.filter((c) => !isRead(c)), "live merge-gate: gh calls that are not reads").toEqual([]);
    const fixture = orch("merge-gate", "7", "--fixture", "approved");
    expect([fixture.status, fixture.stdout.trim().split("\n").at(-1), fixture.stderr], "merge-gate --fixture: result").toEqual([0, "=> PASS", ""]);
    expect(ghCalls(), "merge-gate --fixture: gh calls").toEqual([]);
  });

  it("review_watch_reads_through_gh_and_starts_the_reviewer_command_unless_dry_run", async () => {
    configure();
    expect(orch("task", "claim", "gating", "--as", "author").status, "task claim").toBe(0);
    if (WINDOWS) {
      const refused = orch("review", "watch", "7", "--task", "gating", "--once");
      expect(refused.status, `review watch on Windows: exit code\n${refused.stderr}`).toBe(2);
      expect([ghCalls(), programLines()], "review watch on Windows: gh calls and programs started").toEqual([[], []]);
      return;
    }
    const preview = orch("review", "watch", "7", "--task", "gating", "--dry-run");
    expect([preview.status, preview.stderr], `review watch --dry-run: exit code and stderr\n${preview.stdout}`).toEqual([0, ""]);
    expect(preview.stdout, "review watch --dry-run: result").toContain("ci=green => DISPATCHED (dry run:");
    let calls = ghCalls();
    expect([calls[0], calls.slice(1).map((c) => [c[0], c[2]])], "review watch --dry-run: gh calls").toEqual([PR_VIEW_WATCH, API_WATCH.map((p) => ["api", p])]);
    expect(calls.filter((c) => !isRead(c)), "review watch --dry-run: gh calls that are not reads").toEqual([]);
    expect(programLines(), "review watch --dry-run: programs started").toEqual([]);

    const pass = orch("review", "watch", "7", "--task", "gating", "--once");
    expect([pass.status, pass.stderr], `review watch --once: exit code and stderr\n${pass.stdout}`).toEqual([0, ""]);
    expect(pass.stdout, "review watch --once: result").toContain("ci=green => DISPATCHED (started reviewer");
    calls = ghCalls();
    expect([calls[0], calls.slice(1).map((c) => [c[0], c[2]])], "review watch --once: gh calls").toEqual([PR_VIEW_WATCH, API_WATCH.map((p) => ["api", p])]);
    expect(calls.filter((c) => !isRead(c)), "review watch --once: gh calls that are not reads").toEqual([]);
    await waitFor(() => programLines().length > 0, 150);
    expect(programLines(), "review watch --once: programs started").toEqual(["reviewer 7"]);
  });

  it("review_approve_changes_and_reject_post_one_comment_through_gh_unless_dry_run_and_read_the_head_without_head", () => {
    for (const [verb, word] of [["approve", "APPROVE"], ["changes", "CHANGES"], ["reject", "REJECT"]]) {
      const line = `ORCH-REVIEW ${word} ${HEAD} by r1`;
      const base = ["review", verb, "7", "--as", "r1", "--repo", REPO];

      const post = orch(...base);
      expect([post.status, post.stdout, post.stderr], `review ${verb}: result`).toEqual([0, `posted on #7: ${line}\n`, ""]);
      let calls = ghCalls();
      expect(calls, `review ${verb}: gh calls`).toEqual([PR_VIEW_HEAD, comment(line)]);
      expect(calls.filter((c) => !isRead(c)), `review ${verb}: gh calls that are not reads`).toEqual([comment(line)]);

      const withHead = orch(...base, "--head", HEAD);
      expect([withHead.status, withHead.stdout, withHead.stderr], `review ${verb} --head: result`).toEqual([0, `posted on #7: ${line}\n`, ""]);
      expect(ghCalls(), `review ${verb} --head: gh calls`).toEqual([comment(line)]);

      const dry = orch(...base, "--dry-run");
      expect([dry.status, dry.stdout, dry.stderr], `review ${verb} --dry-run: result`).toEqual([0, `${line}\n`, ""]);
      calls = ghCalls();
      expect(calls, `review ${verb} --dry-run: gh calls`).toEqual([PR_VIEW_HEAD]);
      expect(calls.filter((c) => !isRead(c)), `review ${verb} --dry-run: gh calls that are not reads`).toEqual([]);

      const offline = orch(...base, "--head", HEAD, "--dry-run");
      expect([offline.status, offline.stdout, offline.stderr], `review ${verb} --head --dry-run: result`).toEqual([0, `${line}\n`, ""]);
      expect(ghCalls(), `review ${verb} --head --dry-run: gh calls`).toEqual([]);
    }
  });

  it("update_check_attempts_one_connection_to_the_registry_and_starts_no_gh", () => {
    const r = observed("update", "check");
    expect(r.connections, "update check: connection attempts").toEqual(["registry.npmjs.org:443"]);
    expect([r.status, r.stderr], `update check: exit code and stderr (the entry refuses the connection)\n${r.stdout}`).toEqual([1, ""]);
    expect(r.stdout, "update check: result").toContain("update check: unavailable (connection failed)");
    expect(ghCalls(), "update check: gh calls").toEqual([]);
  });

  it("worker_start_and_load_start_the_configured_programs_and_no_gh", async () => {
    configure();
    if (WINDOWS) {
      const refused = orch("worker", "start", "w1", "--", "fake-worker", "given");
      expect(refused.status, `worker start on Windows: exit code\n${refused.stderr}`).toBe(2);
      const sample = orch("load");
      expect(sample.status, `load on Windows: exit code\n${sample.stderr}`).toBe(0);
      expect([ghCalls(), programLines()], "worker start and load on Windows: gh calls and programs started").toEqual([[], []]);
      return;
    }
    const given = orch("worker", "start", "w1", "--", "fake-worker", "given");
    expect([given.status, given.stderr], `worker start with a command: exit code and stderr\n${given.stdout}`).toEqual([0, ""]);
    await waitFor(() => programLines().length > 0, 150);
    expect(programLines(), "worker start with a command: programs started").toEqual(["worker given"]);
    const configured = orch("worker", "start", "w2");
    expect([configured.status, configured.stderr], `worker start with the configured command: exit code and stderr\n${configured.stdout}`).toEqual([0, ""]);
    await waitFor(() => programLines().length > 1, 150);
    expect(programLines(), "worker start with the configured command: programs started").toEqual(["worker given", "worker configured"]);
    expect(ghCalls(), "worker start: gh calls").toEqual([]);

    const sample = observed("load");
    expect([sample.status, sample.stderr], `load: exit code and stderr\n${sample.stdout}`).toEqual([0, ""]);
    expect(sample.stdout, "load: the number the temperature command printed").toContain("temp=41.5C");
    expect(programLines(), "load: programs started").toEqual(["worker given", "worker configured", "probe"]);
    const read = observed("load", "--read");
    expect([read.status, read.stderr], `load --read: exit code and stderr\n${read.stdout}`).toEqual([0, ""]);
    expect(programLines(), "load --read: programs started").toEqual(["worker given", "worker configured", "probe"]);
    expect([sample.connections, read.connections], "load: connection attempts by the command itself").toEqual([[], []]);
    expect(ghCalls(), "load: gh calls").toEqual([]);
  });

  it("commands_the_line_does_not_name_start_no_gh_and_attempt_no_connection", () => {
    const unnamed: [string[], RegExp][] = [
      [["init"], /^next: orch doctor$/m],
      [["doctor"], /^doctor: (PASS|FAIL) /m],
      [["config"], /^# resolved from /m],
      [["agents"], /^\S+ +absent /m],
      [["task", "claim", "gating", "--as", "author"], /^task gating CLAIMED /m],
      [["profile", "show"], /^profile: /m],
    ];
    for (const [argv, ran] of unnamed) {
      const name = argv.join(" ");
      expect(NAMED.filter((n) => n.split(" ")[0] === argv[0]), `${name}: commands of the line that start with ${argv[0]}`).toEqual([]);
      const r = observed(...argv);
      expect(r.stdout, `${name}: the command ran\n${r.stderr}`).toMatch(ran);
      expect(ghCalls(), `${name}: gh calls`).toEqual([]);
      expect(r.connections, `${name}: connection attempts`).toEqual([]);
    }
    expect(programLines(), "programs started by the commands the line does not name").toEqual([]);
    // the same environment does reach the stand-in gh, and the entry does record a connection attempt
    const live = observed("merge-gate", "7", "--repo", REPO);
    expect(ghCalls(), "control, live merge-gate in the same environment: gh calls").toEqual([PR_VIEW_GATE]);
    expect(live.connections, "control, live merge-gate: connection attempts by the command itself").toEqual([]);
    expect(observed("update", "check").connections, "control, update check in the same environment: connection attempts").toEqual(["registry.npmjs.org:443"]);
  });
});
