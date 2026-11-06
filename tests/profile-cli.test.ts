// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Profiles through the CLI: no [profile] = the output of the release before, byte for byte;
// init questions and flags, profile show/update, doctor rows, merge-gate strength, the worker limit,
// and the refusal of a [profile] written for the removed built-in table.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import * as P from "../src/profile.js";
import { Tasks } from "../src/tasks.js";
import { parseToml } from "../src/toml.js";
import { fakeBin, keepEnv, ROOT, run, testPath, tmp, useTmpHome, waitFor, WINDOWS } from "./_helpers.js";

/** PATH = a temp dir of fake agent CLIs + /usr/bin:/bin; no fallback dirs. */
function useBins() {
  const ctx = useTmpHome();
  const d = { bins: "", get home() { return ctx.home; } };
  keepEnv(["PATH", "ORCH_AGENT_DIRS", "ORCH_TEST_OUT", "ORCH_TEST_JSON"]);
  beforeEach(() => {
    d.bins = tmp("orch-pbins-");
    process.env.PATH = testPath(d.bins);
    process.env.ORCH_AGENT_DIRS = "";
  });
  afterEach(() => rmSync(d.bins, { recursive: true, force: true }));
  return d;
}

const cfgPath = (home: string) => join(home, "config.toml");
const readCfg = (home: string) => readFileSync(cfgPath(home), "utf8");
/** The selection these tests give explicitly (--policy, --required-review, --max-workers). orch has no default for it. */
const EXAMPLE = { policy: "human-merge", required_review: "single-agent", max_workers: 1 };
const AUTO_BLOCKED = "--auto: policy human-merge gives no automatic merge authority; a person performs the merge";

/** Run the CLI with a fake terminal that answers from `answers` (null = end of input). */
async function runTTY(answers: (string | null)[], ...argv: string[]): Promise<[number, string, string, string[]]> {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const code = await main(argv, {
    out: (s) => (out += s), err: (s) => (err += s), stdin: () => "", isTTY: () => true,
    ask: (q) => {
      asked.push(q);
      return answers.length ? answers.shift()! : null;
    },
  });
  return [code, out, err, asked];
}

describe("NoProfileUnchanged", () => {
  const d = useBins();

  it("merge_gate_init_and_doctor_match_the_pre_profile_snapshot", async () => {
    process.env.PATH = testPath();
    const snap = JSON.parse(readFileSync(join(ROOT, "tests", "snapshots", "merge-gate-pre-profiles.json"), "utf8"));
    // Windows: the home also appears with doubled backslashes (inside TOML strings) and is followed by either separator
    const norm = (s: string) => !WINDOWS ? s.split(d.home).join("$ORCH_HOME")
      : s.split(JSON.stringify(d.home).slice(1, -1)).join("$ORCH_HOME").split(d.home).join("$ORCH_HOME").replace(/\$ORCH_HOME\\{1,2}/g, "$ORCH_HOME/");
    // Windows: the platform row has its own name
    if (WINDOWS) snap.doctor_rows = snap.doctor_rows.map((r: string) => (r === "posix (process groups)" ? "windows (no process groups)" : r));
    const [code, out, err] = await run("init", "--no-handbook");
    expect({ out: norm(out), err: norm(err), code }).toEqual(snap.cases["init --no-handbook"]);
    expect(norm(readCfg(d.home))).toBe(snap.config_toml);
    const [, dout] = await run("doctor");
    const rows = dout.split("\n").filter((l) => /^(PASS|FAIL|SKIP) {2}/.test(l)).map((l) => l.slice(6).split(/\s{2,}/)[0].trim());
    expect(rows).toEqual(snap.doctor_rows);
    expect(dout).not.toContain("profile");
    const t = new Tasks(join(d.home, "tasks"));
    t.claim("t-w1", "w1");
    t.claim("t-r1", "r1");
    let n = 0;
    for (const [key, want] of Object.entries<any>(snap.cases)) {
      if (!key.startsWith("merge-gate ")) continue;
      const [c, o, e] = await run("merge-gate", ...want.argv);
      expect({ out: o, err: e, code: c }, key).toEqual({ out: want.out, err: want.err, code: want.code });
      n++;
    }
    expect(n).toBe(96);
  });

  it("tier_and_auto_without_a_profile_are_usage_errors", async () => {
    await run("init", "--no-handbook");
    const [c1, o1, e1] = await run("merge-gate", "101", "--fixture", "approved", "--tier", "low");
    expect([c1, o1]).toEqual([2, ""]);
    expect(e1).toBe("merge-gate: --tier needs a [profile] table in config.toml, and none is set (see `orch profile update`)\n");
    const [c2, , e2] = await run("merge-gate", "101", "--fixture", "approved", "--auto");
    expect([c2, e2]).toEqual([2, "merge-gate: --auto needs a [profile] table in config.toml, and none is set (see `orch profile update`)\n"]);
    expect((await run("profile", "show"))).toEqual([0, "profile: not set (merge gate uses the plain rule)\n", ""]);
    expect((await run("profile", "show", "--json"))[1]).toBe('{"profile": null}\n');
  });

  it("gh_field_list_gains_files_only_with_path_rules", async () => {
    await run("init", "--no-handbook");
    process.env.ORCH_TEST_OUT = join(d.bins, "argv.txt");
    process.env.ORCH_TEST_JSON = join(ROOT, "fixtures", "approved.json");
    // records the argv of `gh pr view` only; `gh api` prints nothing
    fakeBin(d.bins, "gh", '[ "$1" = api ] && exit 0; printf "%s\\n" "$@" > "$ORCH_TEST_OUT"; cat "$ORCH_TEST_JSON"');
    const fields = () => readFileSync(process.env.ORCH_TEST_OUT!, "utf8").split("\n").at(-2);
    await run("merge-gate", "5", "--repo", "o/n");
    expect(fields()).toBe("author,headRefOid,reviews,labels,statusCheckRollup");
    expect((await run("profile", "update", "--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1"))[0]).toBe(0);
    await run("merge-gate", "5", "--repo", "o/n");
    expect(fields()).toBe("author,headRefOid,reviews,labels,statusCheckRollup");
    expect((await run("profile", "update", "--high-path", "migrations/**"))[0]).toBe(0);
    await run("merge-gate", "5", "--repo", "o/n");
    expect(fields()).toBe("author,headRefOid,reviews,labels,statusCheckRollup,files,changedFiles,number");
  });
});

describe("ProfileInit", () => {
  const d = useBins();

  it("flags_write_a_profile_from_detected_clis", async () => {
    fakeBin(d.bins, "claude");
    const codex = fakeBin(d.bins, "codex");
    const [code, out] = await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1");
    expect(code).toBe(0);
    expect(out).toContain("profile: human-merge (multi-vendor · solo), required_review = single-agent, max_workers = 1 (`orch profile show`");
    const cfg = parseToml(readCfg(d.home));
    expect(cfg.profile).toEqual({ ...EXAMPLE, compute: "multi-vendor", people: "solo", lead_account: "acct1", accounts: { acct1: "claude", acct2: "codex" }, agents: {} });
    expect(cfg.agents.codex.command[0]).toBe(codex); // the rest of the config is the default one
  });

  it("flags_without_all_three_selected_values_write_no_profile_and_say_how_to_create_one", async () => {
    fakeBin(d.bins, "claude");
    const sel = [["--policy", "human-merge"], ["--required-review", "cross-account"], ["--max-workers", "3"]];
    // none of the three, and each pair of them: no [profile] table, exit 0, one line that names what is missing
    for (const given of [[], [sel[0], sel[1]], [sel[0], sel[2]], [sel[1], sel[2]]]) {
      const [code, out] = await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo", ...given.flat());
      const missing = sel.filter((s) => !given.includes(s)).map((s) => s[0]).join(", ");
      expect(code, missing).toBe(0);
      expect(parseToml(readCfg(d.home)).profile, missing).toBeUndefined();
      expect(readCfg(d.home)).not.toMatch(/required_review|max_workers|human-merge/);
      expect(out).toContain(`no profile written from the flags: ${missing} not given, and no value is chosen for you. ` +
        "Create one with `orch profile update --compute multi-vendor --people solo --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N`\n");
      expect(out).not.toContain("profile: human-merge");
      rmSync(cfgPath(d.home));
    }
    // all three: the profile carries exactly the given values
    expect((await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo", ...sel.flat()))[0]).toBe(0);
    expect(parseToml(readCfg(d.home)).profile).toMatchObject({ policy: "human-merge", required_review: "cross-account", max_workers: 3 });
    rmSync(cfgPath(d.home));
    // the three flags without --compute/--people, or a limit below 1: exit 2 and no config file
    for (const argv of [sel[0], sel[1], sel[2], ["--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "0"]]) {
      expect((await run("init", "--no-handbook", ...argv))[0], argv.join(" ")).toBe(2);
      expect(() => readCfg(d.home), argv.join(" ")).toThrow();
    }
    // --force with incomplete flags keeps the profile that is there
    await run("init", "--no-handbook", "--compute", "one", "--people", "solo", ...sel.flat());
    const block = readCfg(d.home).slice(readCfg(d.home).indexOf("[profile]"));
    const [fc, fout] = await run("init", "--no-handbook", "--force", "--compute", "one", "--people", "team");
    expect([fc, fout.includes("kept the existing [profile] tables"), fout.includes("no profile written from the flags: --policy, --required-review, --max-workers not given")]).toEqual([0, true, true]);
    expect(readCfg(d.home).endsWith(block)).toBe(true);
  });

  it("one_flag_alone_or_with_no_profile_is_exit_2", async () => {
    for (const argv of [["--compute", "one"], ["--people", "team"], ["--no-profile", "--compute", "one", "--people", "solo"]]) {
      const [code] = await run("init", "--no-handbook", ...argv);
      expect(code, argv.join(" ")).toBe(2);
    }
    expect((await run("init", "--no-handbook", "--compute", "two", "--people", "solo"))[0]).toBe(2);
  });

  it("an_existing_config_is_not_rewritten_by_flags", async () => {
    await run("init", "--no-handbook");
    const before = readCfg(d.home);
    const [code, , err] = await run("init", "--no-handbook", "--compute", "one", "--people", "solo");
    expect(code).toBe(2);
    expect(err).toContain("orch profile update --compute one --people solo");
    expect(readCfg(d.home)).toBe(before);
  });

  it("tty_questions_prefill_vendors", async () => {
    fakeBin(d.bins, "claude");
    fakeBin(d.bins, "codex");
    const [code, out, , asked] = await runTTY(["3", "team", "yes", "2", "4"], "init", "--no-handbook");
    expect(code).toBe(0);
    expect(asked).toEqual([
      "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs? [1/2/3, default 1] ",
      "Solo, or with teammates? [solo/team, default solo] ",
      "Merge policy. The one available is human-merge: a person performs every merge and `orch merge-gate --auto` is always BLOCKED. Select it? [yes/no, no default] ",
      "Weakest agent review that lets the gate pass: single-agent, cross-account or cross-vendor? [1/2/3, no default] ",
      "Most workers running at once? [a whole number, 1 or more, no default] "]);
    expect(out).toContain("profile: human-merge (multi-vendor · team), required_review = cross-account, max_workers = 4");
    expect(parseToml(readCfg(d.home)).profile).toMatchObject({ policy: "human-merge", required_review: "cross-account", max_workers: 4 });
    expect(parseToml(readCfg(d.home)).profile.accounts).toEqual({ acct1: "claude", acct2: "codex" });
  });

  it("tty_defaults_bad_answers_eof_and_no_profile", async () => {
    fakeBin(d.bins, "claude");
    expect((await runTTY(["", "", "yes", "single-agent", "1"], "init", "--no-handbook"))[0]).toBe(0);
    expect(parseToml(readCfg(d.home)).profile).toEqual({ ...EXAMPLE, compute: "one", people: "solo", lead_account: "acct1", accounts: { acct1: "claude" }, agents: {} });
    rmSync(cfgPath(d.home));
    const [, out2, , asked2] = await runTTY(["four", "5", "six"], "init", "--no-handbook");
    expect(asked2.length).toBe(3);
    expect(out2).toContain("no profile written");
    expect(parseToml(readCfg(d.home)).profile).toBeUndefined();
    rmSync(cfgPath(d.home));
    await runTTY([null], "init", "--no-handbook");
    expect(parseToml(readCfg(d.home)).profile).toBeUndefined();
    rmSync(cfgPath(d.home));
    const [, , , asked4] = await runTTY(["2", "solo"], "init", "--no-handbook", "--no-profile");
    expect(asked4).toEqual([]);
    expect(parseToml(readCfg(d.home)).profile).toBeUndefined();
  });

  it("the_terminal_questions_have_no_default_for_policy_review_or_limit", async () => {
    fakeBin(d.bins, "claude");
    const NOT = "no profile written: the profile questions were not all answered, and no value is chosen for you. " +
      "Create one with `orch profile update --compute V --people V --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N`\n";
    // Enter at one of the three questions with valid answers ready for the questions after it (a default on that question alone would write a profile);
    // then Enter three times at each of the three, "no" to the policy, a limit of 0, and end of input after each question: never a profile
    for (const answers of [["", "", "", "1", "2"], ["", "", "yes", "", "5"], ["", "", "yes", "1", ""],
      ["", "", "", "", ""], ["", "", "no"], ["", "", "yes", "", "", ""], ["", "", "yes", "1", "", "", ""], ["", "", "yes", "1", "0", "0", "0"],
      ["", "", null], ["", "", "yes", null], ["", "", "yes", "2", null]] as (string | null)[][]) {
      const [code, out] = await runTTY([...answers], "init", "--no-handbook");
      const what = JSON.stringify(answers);
      expect(code, what).toBe(0);
      expect(parseToml(readCfg(d.home)).profile, what).toBeUndefined();
      expect(readCfg(d.home), what).not.toMatch(/required_review|max_workers|human-merge/);
      expect(out, what).toContain(NOT);
      rmSync(cfgPath(d.home));
    }
  });

  it("force_keeps_the_existing_profile_as_it_was", async () => {
    fakeBin(d.bins, "claude");
    await run("init", "--no-handbook", "--compute", "same-vendor", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1");
    const edited = readCfg(d.home).replace('[profile.agents]\n', '[profile.agents]\n# my reviewer\nr1 = "acct1"\n');
    writeFileSync(cfgPath(d.home), edited.replace('team = "my-team"', 'team = "edited"'));
    const block = edited.slice(edited.indexOf("[profile]"));
    const [code, out] = await run("init", "--no-handbook", "--force");
    expect(code).toBe(0);
    expect(out).toContain("kept the existing [profile] tables");
    const now = readCfg(d.home);
    expect(now).toContain('team = "my-team"'); // the rest is rewritten from defaults
    expect(now.endsWith(block)).toBe(true); // the profile is kept byte for byte, comment included
    // --force with flags replaces it
    await run("init", "--no-handbook", "--force", "--compute", "one", "--people", "team", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1");
    expect(parseToml(readCfg(d.home)).profile.people).toBe("team");
  });
});

describe("ProfileCommand", () => {
  const d = useBins();

  it("update_creates_and_changes_only_the_profile_tables", async () => {
    expect((await run("profile", "update", "--compute", "one", "--people", "solo"))[0]).toBe(2); // no config yet
    await run("init", "--no-handbook");
    const before = readCfg(d.home);
    const [c0, , e0] = await run("profile", "update", "--compute", "one");
    expect([c0, e0]).toEqual([2, "profile: no [profile] yet: creating one needs --compute, --people, --policy, --required-review and --max-workers " +
      "(missing: --people, --policy, --required-review, --max-workers); no value is chosen for you; nothing written\n"]);
    // --compute and --people alone, or any one selected value left out: exit 2, nothing written, no value filled in
    const all = [["--compute", "one"], ["--people", "solo"], ["--policy", "human-merge"], ["--required-review", "single-agent"], ["--max-workers", "1"]];
    for (const left of [[all[2], all[3], all[4]], [all[2]], [all[3]], [all[4]]]) {
      const [c1, , e1] = await run("profile", "update", ...all.filter((x) => !left.includes(x)).flat());
      expect([c1, e1], left.flat().join(" ")).toEqual([2, "profile: no [profile] yet: creating one needs --compute, --people, --policy, --required-review and --max-workers " +
        `(missing: ${left.map((x) => x[0]).join(", ")}); no value is chosen for you; nothing written\n`]);
      expect(readCfg(d.home)).toBe(before);
    }
    const [code, out] = await run("profile", "update", "--compute", "same-vendor", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1",
      "--account", "a1=claude", "--account", "a2=claude", "--agent", "w1=a2", "--agent", "r1=a1", "--high-path", "migrations/**");
    expect(code).toBe(0);
    expect(out).toContain(`updated [profile] in ${cfgPath(d.home)}\nprofile: human-merge (same-vendor · solo)\n`);
    const after = readCfg(d.home);
    expect(after.startsWith(before)).toBe(true); // every earlier byte is unchanged
    // a new profile carries the example policy, written out
    expect(after.slice(before.length)).toBe('\n[profile]\npolicy = "human-merge"\ncompute = "same-vendor"\npeople = "solo"\nrequired_review = "single-agent"\nhigh_paths = ["migrations/**"]\nmax_workers = 1\n\n' +
      '[profile.accounts]\na1 = "claude"\na2 = "claude"\n\n[profile.agents]\nw1 = "a2"\nr1 = "a1"\n');
  });

  it("update_in_the_middle_keeps_comments_and_other_tables", async () => {
    await run("init", "--no-handbook");
    const base = readCfg(d.home);
    const at = base.indexOf("[review]");
    const text = base.slice(0, at) + '[profile]\npolicy = "human-merge"\ncompute = "one"\npeople = "solo"\nrequired_review = "single-agent"\nmax_workers = 1\n\n' + base.slice(at);
    writeFileSync(cfgPath(d.home), text);
    // the comment lines above [review] stay where they are
    const cut = text.lastIndexOf("\n\n", text.indexOf("[review]")) + 1;
    const pre = text.slice(0, text.indexOf("[profile]"));
    const post = text.slice(cut);
    expect(post.startsWith("\n[review]") || post.startsWith("\n#")).toBe(true);
    expect((await run("profile", "update", "--people", "team", "--teammate", "carol"))[0]).toBe(0);
    const now = readCfg(d.home);
    expect(now.startsWith(pre)).toBe(true);
    expect(now.endsWith(post)).toBe(true);
    expect(parseToml(now).profile).toEqual({ ...EXAMPLE, compute: "one", people: "team", teammates: ["carol"], accounts: {}, agents: {} });
    const { profile: _a, ...rest1 } = parseToml(text);
    const { profile: _b, ...rest2 } = parseToml(now);
    expect(rest2).toEqual(rest1);
  });

  it("dry_run_and_invalid_updates_write_nothing", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1", "--account", "a1=claude");
    const before = readCfg(d.home);
    const [c1, o1] = await run("profile", "update", "--teammate", "carol", "--dry-run");
    expect(c1).toBe(0);
    expect(o1).toBe('[profile]\npolicy = "human-merge"\ncompute = "one"\npeople = "solo"\nrequired_review = "single-agent"\nteammates = ["carol"]\nmax_workers = 1\n\n[profile.accounts]\na1 = "claude"\n\n[profile.agents]\n');
    for (const [argv, msg] of [
      [["--agent", "r9=nope"], "'nope' is not an account"],
      [["--remove-account", "zz"], "no account 'zz' in [profile.accounts]"],
      [["--remove-teammate", "zz"], "'zz' is not in [profile] teammates"],
      [["--account", "bad"], "--account takes NAME=VALUE"],
      [["--max-workers", "-1"], "max_workers must be an integer >= 1"],
      [["--max-workers", "0"], "max_workers must be an integer >= 1 (got 0)"], // 0 is not "derived": nothing is derived
      [["--account", "a b=claude"], "is not a valid name"],
      [["--agent", "constructor=a1"], "the name 'constructor' is not allowed"],
    ] as [string[], string][]) {
      const [code, , err] = await run("profile", "update", ...argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(err).toContain(msg);
      expect(err).toContain("nothing written");
      expect(readCfg(d.home)).toBe(before);
    }
    // the agent names an account, so the account cannot be removed while it is in use
    await run("profile", "update", "--agent", "r1=a1");
    expect((await run("profile", "update", "--remove-account", "a1"))[0]).toBe(2);
  });

  it("an_inline_profile_is_not_rewritten", async () => {
    await run("init", "--no-handbook");
    const text = readCfg(d.home).replace("[orch]\n", 'profile = { compute = "one", people = "solo" }\n\n[orch]\n');
    writeFileSync(cfgPath(d.home), text);
    const [code, , err] = await run("profile", "update", "--people", "team");
    expect(code).toBe(2);
    expect(err).toContain("found 'profile' under the top level");
    expect(err).toContain("nothing written");
    expect(readCfg(d.home)).toBe(text);
  });

  it("dotted_keys_and_inline_tables_in_the_profile_are_config_errors", async () => {
    await run("init", "--no-handbook");
    const base = readCfg(d.home);
    for (const [block, msg] of [
      ['[profile]\ncompute = "one"\npeople = "solo"\naccounts.a1 = "claude"\n', "found the dotted key 'accounts.a1' in [profile]"],
      ['[profile]\ncompute = "one"\npeople = "solo"\naccounts = { a1 = "claude" }\n', "found 'profile.accounts' (use a [profile.accounts] table)"],
      ['[profile]\ncompute = "one"\npeople = "solo"\n[profile.accounts]\na1 = "claude"\n[profile.agents]\nr1.x = "a1"\n', "found the dotted key 'r1.x' in [profile.agents]"],
      ['profile.compute = "one"\nprofile.people = "solo"\n', "found 'profile.compute' under the top level"],
    ] as [string, string][]) {
      const text = block.startsWith("profile.") ? block + base : base + "\n" + block;
      writeFileSync(cfgPath(d.home), text);
      const [c1, , e1] = await run("merge-gate", "101", "--fixture", "approved");
      expect([c1, e1.includes(msg)], block).toEqual([2, true]);
      const [c2, , e2] = await run("profile", "update", "--people", "team");
      expect([c2, e2.includes(msg), e2.includes("nothing written")], block).toEqual([2, true, true]);
      expect(readCfg(d.home)).toBe(text);
      expect((await run("doctor"))[1]).toContain("FAIL  profile");
    }
  });

  it("a_crlf_config_stays_crlf", async () => {
    await run("init", "--no-handbook");
    const crlf = readCfg(d.home).replace(/\n/g, "\r\n");
    writeFileSync(cfgPath(d.home), crlf);
    expect((await run("profile", "update", "--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1", "--account", "a1=claude"))[0]).toBe(0);
    const once = readCfg(d.home);
    expect(once.startsWith(crlf)).toBe(true);
    expect(once.replace(/\r\n/g, "")).not.toContain("\n"); // no bare LF anywhere
    expect((await run("profile", "update", "--teammate", "carol"))[0]).toBe(0);
    const twice = readCfg(d.home);
    expect(twice.startsWith(crlf)).toBe(true);
    expect(twice.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseToml(twice).profile.teammates).toEqual(["carol"]);
  });

  it("show_text_and_json", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--account", "c1=claude", "--account", "c2=claude",
      "--account", "x1=codex", "--agent", "lead=c1", "--agent", "w1=c2", "--agent", "rx=x1", "--lead-account", "c1", "--high-path", "infra/**",
      "--required-review", "cross-vendor", "--max-workers", "4");
    const [code, out] = await run("profile", "show");
    expect(code).toBe(0);
    expect(out.split("\n").slice(0, 7)).toEqual([
      "profile: human-merge (multi-vendor · solo)",
      "accounts: c1 (claude), c2 (claude), x1 (codex); lead c1",
      "agents: lead=c1, w1=c2, rx=x1",
      "teammates: none",
      "tiers: default=high high_paths=infra/**",
      "low:  review=cross-vendor teammate=no authority=owner worker_cap=4",
      "high: review=cross-vendor teammate=no authority=owner worker_cap=4",
    ]);
    // no claude or codex CLI on PATH: the vendor rows are missing capabilities
    expect(out).toContain("missing: profile vendor codex: account x1 is on 'codex', but no codex CLI was found and no [agents.codex] is configured");
    const j = JSON.parse((await run("profile", "show", "--json"))[1]);
    expect(Object.keys(j)).toEqual(["policy", "compute", "people", "lead_account", "required_review", "default_tier", "high_paths",
      "teammates", "accounts", "agents", "max_workers", "rules", "missing"]);
    expect(j.rules.high).toEqual({ need_agent: "cross-vendor", need_teammate: false, authority: "owner", worker_cap: 4 });
    // accounts that stop backing the requirement are reported as missing; the rule and the limit stay as written
    await run("profile", "update", "--account", "x1=claude");
    const after = (await run("profile", "show"))[1];
    expect(after.split("\n").slice(0, 1).concat(after.split("\n").slice(5, 7))).toEqual([
      "profile: human-merge (multi-vendor · solo)",
      "low:  review=cross-vendor teammate=no authority=owner worker_cap=4",
      "high: review=cross-vendor teammate=no authority=owner worker_cap=4",
    ]);
    expect(after).toContain("missing: profile vendors: multi-vendor declared, but every account is on 'claude'; no review can grade as cross-vendor until an account on another vendor is added");
    expect(after).toContain("missing: profile reviewers: required_review = cross-vendor, but every agent in [profile.agents] is on vendor claude; every PR stays BLOCKED until an agent on another vendor is added");
  });
});

describe("ProfileDoctor", () => {
  const d = useBins();
  const rowsOf = (out: string) => out.split("\n").filter((l) => / {2}profile/.test(l)).map((l) => l.replace(/ {2,}/g, "  "));

  it("missing_capabilities_are_skip_rows", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "same-vendor", "--people", "team", "--policy", "human-merge", "--max-workers", "1", "--account", "a1=codex", "--required-review", "cross-account");
    const [code, out] = await run("doctor");
    expect(code, out).toBe(0);
    expect(rowsOf(out)).toEqual([
      "PASS  profile  human-merge (same-vendor · team): accounts a1 (codex)",
      "SKIP  profile accounts  same-vendor declared, but only one account is listed in [profile.accounts]; no review can grade above single-agent until a second account is added",
      "SKIP  profile vendor codex  account a1 is on 'codex', but no codex CLI was found and no [agents.codex] is configured",
      "SKIP  profile teammates  people = team, but [profile] teammates is empty; high-tier PRs stay BLOCKED until a login is added",
      "SKIP  profile teammate reviews  teammate approvals are read from GitHub; gh is absent or [merge] repo is unset",
      "SKIP  profile reviewers  required_review = cross-account, but no agent is listed in [profile.agents]; every PR stays BLOCKED until an agent on another account is added",
      "PASS  profile agents  0 agent(s) mapped",
    ]);
  });

  it("vendor_and_reviewer_rows", async () => {
    fakeBin(d.bins, "claude");
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--max-workers", "1", "--account", "a1=claude", "--account", "a2=claude", "--agent", "w1=a1",
      "--required-review", "cross-account");
    const out = (await run("doctor"))[1];
    expect(rowsOf(out)).toEqual([
      "PASS  profile  human-merge (multi-vendor · solo): accounts a1, a2 (claude)",
      "PASS  profile accounts  2 accounts",
      "SKIP  profile vendors  multi-vendor declared, but every account is on 'claude'; no review can grade as cross-vendor until an account on another vendor is added",
      "PASS  profile vendor claude  CLI found",
      "SKIP  profile reviewers  required_review = cross-account, but every agent in [profile.agents] is on account a1; every PR stays BLOCKED until an agent on another account is added",
      "SKIP  profile agents  1 agent(s) in [agents.*] have no account in [profile.agents]; their approvals grade as single-agent",
    ]);
  });

  it("fully_backed_profile_is_all_pass", async () => {
    fakeBin(d.bins, "claude");
    fakeBin(d.bins, "codex");
    await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1");
    await run("profile", "update", "--agent", "claude=acct1", "--agent", "codex=acct2", "--required-review", "cross-vendor");
    const rows = rowsOf((await run("doctor"))[1]);
    expect(rows[0]).toBe("PASS  profile  human-merge (multi-vendor · solo): accounts acct1 (claude), acct2 (codex)");
    expect(rows[5]).toBe("PASS  profile reviewers  agents on vendors claude, codex");
    expect(rows.every((r) => r.startsWith("PASS"))).toBe(true);
    expect(rows.length).toBe(7);
  });

  it("an_invalid_profile_is_a_fail_row_and_exit_2_elsewhere", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + '\n[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 1\ncompute = "two"\npeople = "solo"\n');
    const [code, out] = await run("doctor");
    expect(code).toBe(1);
    expect(rowsOf(out)).toEqual(['FAIL  profile  [profile] compute must be "one" or "same-vendor" or "multi-vendor" (got "two")']);
    const [c2, , e2] = await run("merge-gate", "101", "--fixture", "approved");
    expect(c2).toBe(2);
    expect(e2).toContain("[profile] compute must be");
    expect((await run("profile", "show"))[0]).toBe(2);
    expect((await run("lease", "status"))[0]).toBe(0); // commands that do not read the profile are unaffected
  });
});

describe("ProfileMergeGate", () => {
  const d = useBins();
  const setup = async (...argv: string[]) => {
    await run("init", "--no-handbook");
    expect((await run("profile", "update", ...argv))[0]).toBe(0);
  };

  it("comments_mode_passes_for_a_person_and_auto_is_always_blocked", async () => {
    await setup("--compute", "same-vendor", "--people", "solo", "--policy", "human-merge", "--max-workers", "1", "--account", "acct1=codex", "--account", "acct2=codex", "--agent", "w1=acct2", "--agent", "r1=acct1",
      "--required-review", "cross-account");
    new Tasks(join(d.home, "tasks")).claim("t1", "w1");
    const base = ["merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t1"];
    const summary = "#101 head=4f2c9a1e7 ci=green reviews=comments author=w1 approvals=1/1 [r1] (stale=0 self=0 malformed=0) changes_requested=0 label=off\n";
    // the review rule is met on both tiers: a person may merge, automation may not
    expect(await run(...base, "--tier", "low")).toEqual([0,
      summary + "profile=human-merge tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=owner\n=> PASS (the owner decides the merge)\n", ""]);
    expect(await run(...base, "--tier", "low", "--auto")).toEqual([1,
      summary + "profile=human-merge tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=owner\n" +
      `=> BLOCKED (${AUTO_BLOCKED})\n`, ""]);
    expect(await run(...base, "--auto")).toEqual([1,
      summary + "profile=human-merge tier=high(default) review=cross-account needed=cross-account teammate=n/a authority=owner\n" +
      `=> BLOCKED (${AUTO_BLOCKED})\n`, ""]);
    expect((await run(...base))[1].split("\n").at(-2)).toBe("=> PASS (the owner decides the merge)");
  });

  it("a_tier_flag_other_than_low_or_high_is_exit_2_with_no_verdict", async () => {
    await setup("--compute", "one", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1", "--account", "a1=codex", "--agent", "w1=a1", "--agent", "r1=a1");
    new Tasks(join(d.home, "tasks")).claim("t1", "w1");
    for (const tier of ["medium", "", "HIGH"]) {
      const [code, out] = await run("merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t1", "--tier", tier);
      expect([code, out], tier).toEqual([2, ""]);
    }
    // a configured default_tier outside low/high is refused the same way
    expect((await run("profile", "update", "--default-tier", "medium"))[0]).toBe(2);
  });

  it("github_mode_blocks_below_the_required_strength_on_every_tier", async () => {
    await setup("--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--max-workers", "1", "--account", "c1=claude", "--account", "c2=claude", "--account", "x1=codex",
      "--agent", "alice=c2", "--agent", "bob=c1", "--agent", "rx=x1", "--high-path", "migrations/**", "--required-review", "cross-vendor");
    const [code, out] = await run("merge-gate", "101", "--fixture", "high-path");
    expect([code, out]).toEqual([1, "#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=human-merge tier=high(path: migrations/0042_add_index.sql) review=cross-account needed=cross-vendor teammate=n/a authority=owner\n" +
      "=> BLOCKED (review strength cross-account is below cross-vendor)\n"]);
    // no file list in the PR data: high tier
    expect((await run("merge-gate", "101", "--fixture", "approved", "--json"))[1]).toContain('"tier": "high", "tier_source": "files unreadable"');
    // --tier low is honoured as the tier, and it does not lower the review strength the profile asks for
    const j = JSON.parse((await run("merge-gate", "101", "--fixture", "high-path", "--tier", "low", "--json"))[1]);
    expect([j.ok, j.profile.tier, j.profile.tier_source, j.profile.needed, j.profile.achieved]).toEqual([false, "low", "flag", "cross-vendor", "cross-account"]);
    expect(Object.keys(j.profile)).toEqual(["policy", "tier", "tier_source", "achieved", "needed", "teammate", "need_teammate",
      "authority", "worker_cap", "reasons"]);
    expect(Object.keys(j).slice(0, -1)).toEqual(["head", "ok", "need", "ci_ok", "checks", "label", "label_ok", "approvals", "stale", "self", "changes_requested"]);
    // with the strength the reviewers can give, the same PR passes for a person
    expect((await run("profile", "update", "--required-review", "cross-account"))[0]).toBe(0);
    const ok = JSON.parse((await run("merge-gate", "101", "--fixture", "high-path", "--json"))[1]);
    expect([ok.ok, ok.profile.policy, ok.profile.authority]).toEqual([true, "human-merge", "owner"]);
  });

  it("teammate_fixtures_under_a_team_profile", async () => {
    await setup("--compute", "same-vendor", "--people", "team", "--policy", "human-merge", "--max-workers", "1", "--teammate", "carol", "--account", "a1=claude", "--account", "a2=claude",
      "--agent", "bob=a1", "--agent", "alice=a2", "--required-review", "cross-account");
    const ok = await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", "high");
    expect(ok).toEqual([0, "#101 head=4f2c9a1e7 ci=green approvals=2/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=human-merge tier=high(flag) review=cross-account needed=cross-account teammate=approved authority=teammate\n" +
      "=> PASS (the teammate who approved, or the owner, performs the merge)\n", ""]);
    const stale = await run("merge-gate", "101", "--fixture", "teammate-stale", "--tier", "high");
    expect(stale[0]).toBe(1);
    expect(stale[1]).toContain("teammate=missing");
    expect(stale[1]).toContain("=> BLOCKED (a teammate's approval at the head is required)");
    // a teammate's approval is not an agent review: carol alone does not meet cross-account
    const solo = structuredClone(JSON.parse(readFileSync(join(ROOT, "fixtures", "teammate-approved.json"), "utf8")));
    solo.reviews = solo.reviews.filter((r: any) => r.author.login === "carol");
    const fx = join(d.bins, "carol-only.json");
    writeFileSync(fx, JSON.stringify(solo));
    expect((await run("merge-gate", "101", "--fixture", fx, "--tier", "high"))[1]).toContain("review=none needed=cross-account teammate=approved");
    // --auto is BLOCKED on both tiers, with the teammate's approval and the review rule met; without it a person may merge
    for (const tier of ["high", "low"]) {
      const auto = await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", tier, "--auto");
      expect([auto[0], auto[1].includes(`=> BLOCKED (${AUTO_BLOCKED})`)], tier).toEqual([1, true]);
      expect((await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", tier))[0], tier).toBe(0);
    }
    // the low tier does not need the teammate; the stale teammate approval still blocks the high tier only
    expect((await run("merge-gate", "101", "--fixture", "teammate-stale", "--tier", "low"))[1]).toContain("teammate=missing authority=owner\n=> PASS (the owner decides the merge)");
  });
});

describe("ProfileFileList", () => {
  const d = useBins();
  const files = (n: number) => Array.from({ length: n }, (_, i) => (i === 100 ? "migrations/0042_add_index.sql" : `src/f${String(i).padStart(3, "0")}.ts`));

  /** fake gh: `pr view` prints PR data with the first 100 files and changedFiles=101; `api` prints `apiFiles` (or fails). */
  function fakeGh(apiFiles: string[] | "fail") {
    const pr = structuredClone(JSON.parse(readFileSync(join(ROOT, "fixtures", "approved.json"), "utf8")));
    Object.assign(pr, { number: 7, changedFiles: 101, files: files(101).slice(0, 100).map((path) => ({ path })) });
    writeFileSync(join(d.bins, "pr.json"), JSON.stringify(pr));
    writeFileSync(join(d.bins, "api.txt"), apiFiles === "fail" ? "" : apiFiles.join("\n") + "\n");
    fakeBin(d.bins, "gh", apiFiles === "fail" ? `[ "$1" = api ] && { echo "HTTP 502" >&2; exit 1; }; cat "${d.bins}/pr.json"`
      : `if [ "$1" = api ]; then printf "%s\\n" "$@" > "${d.bins}/api-argv.txt"; cat "${d.bins}/api.txt"; else cat "${d.bins}/pr.json"; fi`);
  }

  const setup = async () => {
    await run("init", "--no-handbook");
    // a team profile: the high tier needs carol's approval, which the PR data does not have. So a tier that
    // drops to low because a path was missed would show as PASS.
    expect((await run("profile", "update", "--compute", "same-vendor", "--people", "team", "--policy", "human-merge", "--max-workers", "1", "--teammate", "carol", "--default-tier", "low", "--high-path", "migrations/**",
      "--account", "c1=claude", "--account", "c2=claude", "--agent", "alice=c1", "--agent", "bob=c2", "--required-review", "cross-account"))[0]).toBe(0);
  };

  it("a_path_past_the_first_100_files_is_not_missed", async () => {
    await setup();
    // the paginated list is also cut at 100: the count does not match changedFiles, so the list is unreadable
    fakeGh(files(101).slice(0, 100));
    const [code, out] = await run("merge-gate", "7", "--repo", "o/n");
    expect(code).toBe(1);
    expect(out).toContain("profile=human-merge tier=high(files unreadable) review=cross-account needed=cross-account teammate=missing authority=teammate\n");
    expect(out).toContain("=> BLOCKED (a teammate's approval at the head is required)");
    // the full paginated list finds file #101
    fakeGh(files(101));
    const [code2, out2] = await run("merge-gate", "7", "--repo", "o/n");
    expect(code2).toBe(1);
    expect(out2).toContain("tier=high(path: migrations/0042_add_index.sql)");
    expect(out2).toContain("=> BLOCKED (a teammate's approval at the head is required)");
    expect(readFileSync(join(d.bins, "api-argv.txt"), "utf8").split("\n").slice(0, -1)).toEqual(["api", "--paginate", "repos/o/n/pulls/7/files", "--jq", ".[].filename"]);
    // a failed fetch is unreadable too
    fakeGh("fail");
    const failed = await run("merge-gate", "7", "--repo", "o/n");
    expect([failed[0], failed[1].includes("tier=high(files unreadable)")]).toEqual([1, true]);
    // control: 101 files without a high path, all listed: the default tier (low) holds and a person may merge
    fakeGh(files(100).concat(["src/f100.ts"]));
    const pr = JSON.parse(readFileSync(join(d.bins, "pr.json"), "utf8"));
    expect(pr.changedFiles).toBe(101);
    expect(await run("merge-gate", "7", "--repo", "o/n")).toEqual([0, "#7 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=human-merge tier=low(default) review=cross-account needed=cross-account teammate=missing authority=owner\n=> PASS (the owner decides the merge)\n", ""]);
    // and automation still may not
    expect((await run("merge-gate", "7", "--repo", "o/n", "--auto"))[0]).toBe(1);
  });
});

describe("ProfileVendorCase", () => {
  const d = useBins();

  it("vendor_names_differing_in_case_are_one_vendor", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + '\n[profile]\npolicy = "human-merge"\nrequired_review = "cross-vendor"\nmax_workers = 1\ncompute = "multi-vendor"\npeople = "team"\nteammates = ["carol"]\n\n' +
      '[profile.accounts]\nc1 = "claude"\nc2 = "Claude"\n\n[profile.agents]\nalice = "c1"\nbob = "c2"\n');
    // "claude" and "Claude" are one vendor, so the review grades cross-account and stays below cross-vendor
    const [code, out] = await run("merge-gate", "7", "--fixture", "approved", "--tier", "low");
    expect(code).toBe(1);
    expect(out).toContain("profile=human-merge tier=low(flag) review=cross-account needed=cross-vendor teammate=missing authority=owner\n");
    expect(out).toContain("=> BLOCKED (review strength cross-account is below cross-vendor)");
    expect((await run("doctor"))[1]).toMatch(/SKIP {2}profile vendors +multi-vendor declared, but every account is on 'claude'/);
  });
});

describe.skipIf(process.platform === "win32")("ProfileWorkers", () => {
  const d = useBins();

  it("worker_start_refuses_at_the_written_limit_and_force_overrides", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "multi-vendor", "--people", "solo", "--policy", "human-merge", "--required-review", "single-agent", "--max-workers", "1", "--account", "a1=claude", "--account", "a2=codex", "--account", "a3=codex");
    const start = (name: string, ...extra: string[]) => run("worker", "start", name, "--workdir", d.home, "--minutes", "0", ...extra, "--", "sleep", "30");
    try {
      expect((await start("w1"))[0]).toBe(0);
      expect(await waitFor(() => readFileSync(join(d.home, "workers", "w1", "PID"), "utf8").trim() !== "")).toBe(true);
      // three accounts on two vendors, and the limit is still the 1 written in the table
      const [code, , err] = await start("w2");
      expect(code).toBe(2);
      expect(err).toBe("worker: 1 worker(s) running and [profile] max_workers is 1; stop one, raise max_workers, or pass --force\n");
      // raising the written limit admits the next worker without --force
      expect((await run("profile", "update", "--max-workers", "2"))[0]).toBe(0);
      expect((await start("w2"))[0]).toBe(0);
      expect(await waitFor(() => readFileSync(join(d.home, "workers", "w2", "PID"), "utf8").trim() !== "")).toBe(true);
      expect((await start("w3"))[2]).toContain("2 worker(s) running and [profile] max_workers is 2");
      const forced = await start("w3", "--force");
      expect([forced[0], forced[2]]).toEqual([0, "worker: warning: --force starts w3 above [profile] max_workers (2 running, limit 2)\n"]);
    } finally {
      await run("worker", "stop", "w1");
      await run("worker", "stop", "w2");
      await run("worker", "stop", "w3");
    }
  });
});

describe("ProfileLegacy", () => {
  const d = useBins();
  // what the source accepted before this change: two accounts on one CLI, one person. Its built-in table let a low-tier PR pass `--auto`.
  const LEGACY = '\n[profile]\ncompute = "same-vendor"\npeople = "solo"\ndefault_tier = "low"\nworkers_per_account = 2\n\n' +
    '[profile.accounts]\nacct1 = "codex"\nacct2 = "codex"\n\n[profile.agents]\nw1 = "acct2"\nr1 = "acct1"\n';
  const NO_POLICY = "[profile] has no policy key: it may have been written for the built-in compute x people table that an earlier orch-os source version carried, or written by hand. That table is removed. " +
    "No rule is chosen for you and none is applied; set policy = \"human-merge\"";

  it("a_profile_written_for_the_removed_table_is_refused_by_every_command_that_reads_it", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + LEGACY);
    const before = readCfg(d.home);
    new Tasks(join(d.home, "tasks")).claim("t1", "w1");
    const gate = ["merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t1"];
    // no verdict at all: not PASS, not BLOCKED. --tier low --auto was the automatic-merge path of the removed table.
    // Windows: `worker start` and `review watch` are refused before the profile is read, so those two are left out there (docs/windows.md)
    const posixOnly = WINDOWS ? [] : [["worker", "start", "w9", "--workdir", d.home, "--", "sleep", "30"],
      ["review", "watch", "7", "--task", "t1", "--repo", "o/n", "--once"]];
    for (const argv of [gate, [...gate, "--tier", "low", "--auto"], ["profile", "show"], ...posixOnly]) {
      const [code, out, err] = await run(...argv);
      expect([code, out], argv.join(" ")).toEqual([2, ""]);
      expect(err, argv.join(" ")).toContain(NO_POLICY);
      expect(err).toContain("orch profile update --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N");
      expect(err).not.toContain("--required-review cross-account --max-workers 2");
    }
    expect((await run("worker", "list"))[1]).not.toContain("w9"); // nothing was started
    const [dc, dout] = await run("doctor");
    expect(dc).toBe(1);
    expect(dout).toMatch(/FAIL {2}profile +\[profile\] has no policy key/);
    // an update that does not select the policy writes nothing
    const [uc, , uerr] = await run("profile", "update", "--teammate", "carol");
    expect([uc, uerr.includes(NO_POLICY), uerr.includes("nothing written")]).toEqual([2, true, true]);
    expect(readCfg(d.home)).toBe(before);
    // selecting the policy without the limit names the removed key
    const [wc, , werr] = await run("profile", "update", "--policy", "human-merge", "--required-review", "cross-account");
    expect([wc, werr.includes("workers_per_account is not supported"), werr.includes("nothing written")]).toEqual([2, true, true]);
    expect(readCfg(d.home)).toBe(before);
    expect((await run("lease", "status"))[0]).toBe(0); // commands that do not read the profile are unaffected
  });

  it("init_force_keeps_a_legacy_profile_byte_for_byte_and_says_it_cannot_be_used", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + LEGACY);
    const [code, out, err] = await run("init", "--no-handbook", "--force");
    expect(code).toBe(2);
    expect(readCfg(d.home).endsWith(LEGACY.slice(1))).toBe(true); // the block is kept byte for byte
    expect(out).toContain("kept the existing [profile] tables");
    expect(out).not.toContain("next: orch doctor"); // setup is not reported as finished
    expect(err).toContain(`init: the kept [profile] cannot be used as it is: ${NO_POLICY}`);
    expect(err).toContain("orch profile update --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N");
    expect(err).not.toContain("--required-review cross-account --max-workers 2");
    expect(err).toContain("the [profile] tables were kept byte for byte");
    expect(P.profileBlock(readCfg(d.home))).toBe(LEGACY.slice(1));
    // a kept profile that is usable still ends with the next step and exit 0
    expect((await run("profile", "update", "--policy", "human-merge", "--required-review", "cross-account", "--max-workers", "2"))[0]).toBe(0);
    const [c2, out2, err2] = await run("init", "--no-handbook", "--force");
    expect([c2, out2.endsWith("next: orch doctor\n"), err2]).toEqual([0, true, ""]);
  });

  it("init_without_force_reports_a_legacy_profile_refusal", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + LEGACY);
    const [code, out, err] = await run("init", "--no-handbook");
    expect(code).toBe(0);
    expect(out).not.toContain("wrote ");
    expect(err).toContain(`init: the existing [profile] cannot be used as it is: ${NO_POLICY}`);
  });

  it("the_named_migration_command_selects_the_policy_explicitly", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + LEGACY);
    new Tasks(join(d.home, "tasks")).claim("t1", "w1");
    expect((await run("profile", "update", "--policy", "human-merge", "--required-review", "cross-account", "--max-workers", "2"))[0]).toBe(0);
    expect(parseToml(readCfg(d.home)).profile).toEqual({ policy: "human-merge", compute: "same-vendor", people: "solo", required_review: "cross-account",
      default_tier: "low", max_workers: 2, accounts: { acct1: "codex", acct2: "codex" }, agents: { w1: "acct2", r1: "acct1" } });
    const gate = ["merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t1"];
    expect((await run(...gate))[1]).toContain("profile=human-merge tier=low(default) review=cross-account needed=cross-account teammate=n/a authority=owner\n=> PASS (the owner decides the merge)");
    // the path that merged automatically under the removed table is BLOCKED
    const auto = await run(...gate, "--tier", "low", "--auto");
    expect([auto[0], auto[1].includes(`=> BLOCKED (${AUTO_BLOCKED})`)]).toEqual([1, true]);
  });
});
