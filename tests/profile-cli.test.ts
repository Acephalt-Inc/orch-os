// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Adaptive profiles through the CLI: no [profile] = the output of the release before, byte for byte;
// init questions and flags, profile show/update, doctor rows, merge-gate strength, worker cap.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { Tasks } from "../src/tasks.js";
import { parseToml } from "../src/toml.js";
import { fakeBin, keepEnv, ROOT, run, tmp, useTmpHome, waitFor } from "./_helpers.js";

/** PATH = a temp dir of fake agent CLIs + /usr/bin:/bin; no fallback dirs. */
function useBins() {
  const ctx = useTmpHome();
  const d = { bins: "", get home() { return ctx.home; } };
  keepEnv(["PATH", "ORCH_AGENT_DIRS", "ORCH_TEST_OUT", "ORCH_TEST_JSON"]);
  beforeEach(() => {
    d.bins = tmp("orch-pbins-");
    process.env.PATH = `${d.bins}:/usr/bin:/bin`;
    process.env.ORCH_AGENT_DIRS = "";
  });
  afterEach(() => rmSync(d.bins, { recursive: true, force: true }));
  return d;
}

const cfgPath = (home: string) => join(home, "config.toml");
const readCfg = (home: string) => readFileSync(cfgPath(home), "utf8");

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
    process.env.PATH = "/usr/bin:/bin";
    const snap = JSON.parse(readFileSync(join(ROOT, "tests", "snapshots", "merge-gate-pre-profiles.json"), "utf8"));
    const norm = (s: string) => s.split(d.home).join("$ORCH_HOME");
    const [code, out, err] = await run("init", "--no-handbook");
    expect({ out: norm(out), err: norm(err), code }).toEqual(snap.cases["init --no-handbook"]);
    expect(norm(readCfg(d.home))).toBe(snap.config_toml);
    const [, dout] = await run("doctor");
    const rows = dout.split("\n").filter((l) => /^(PASS|FAIL|SKIP) {2}/.test(l)).map((l) => l.slice(6).split(/\s{2,}/)[0].trim());
    expect(rows.filter((r) => !r.startsWith("schedule "))).toEqual(snap.doctor_rows);
    expect(rows.filter((r) => r.startsWith("schedule "))).toEqual(["schedule lease-renew", "schedule load-sample"]);
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
    expect((await run("profile", "update", "--compute", "one", "--people", "solo"))[0]).toBe(0);
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
    fakeBin(d.bins, "codex");
    const [code, out] = await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo");
    expect(code).toBe(0);
    expect(out).toContain("profile: cell C (multi-vendor · solo)");
    const cfg = parseToml(readCfg(d.home));
    expect(cfg.profile).toEqual({ compute: "multi-vendor", people: "solo", lead_account: "acct1", accounts: { acct1: "claude", acct2: "codex" }, agents: {} });
    expect(cfg.agents.codex.command[0]).toBe(`${d.bins}/codex`); // the rest of the config is the default one
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
    const [code, out, , asked] = await runTTY(["3", "team"], "init", "--no-handbook");
    expect(code).toBe(0);
    expect(asked).toEqual([
      "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs? [1/2/3, default 1] ",
      "Solo, or with teammates? [solo/team, default solo] "]);
    expect(out).toContain("profile: cell F (multi-vendor · team)");
    expect(parseToml(readCfg(d.home)).profile.accounts).toEqual({ acct1: "claude", acct2: "codex" });
  });

  it("tty_defaults_bad_answers_eof_and_no_profile", async () => {
    fakeBin(d.bins, "claude");
    expect((await runTTY(["", ""], "init", "--no-handbook"))[0]).toBe(0);
    expect(parseToml(readCfg(d.home)).profile).toEqual({ compute: "one", people: "solo", lead_account: "acct1", accounts: { acct1: "claude" }, agents: {} });
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

  it("force_keeps_the_existing_profile_as_it_was", async () => {
    fakeBin(d.bins, "claude");
    await run("init", "--no-handbook", "--compute", "same-vendor", "--people", "solo");
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
    await run("init", "--no-handbook", "--force", "--compute", "one", "--people", "team");
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
    expect([c0, e0]).toEqual([2, "profile: no [profile] yet: creating one needs both --compute and --people; nothing written\n"]);
    const [code, out] = await run("profile", "update", "--compute", "same-vendor", "--people", "solo",
      "--account", "a1=claude", "--account", "a2=claude", "--agent", "w1=a2", "--agent", "r1=a1", "--high-path", "migrations/**");
    expect(code).toBe(0);
    expect(out).toContain(`updated [profile] in ${cfgPath(d.home)}\nprofile: cell B (same-vendor · solo)\n`);
    const after = readCfg(d.home);
    expect(after.startsWith(before)).toBe(true); // every earlier byte is unchanged
    expect(after.slice(before.length)).toBe('\n[profile]\ncompute = "same-vendor"\npeople = "solo"\nhigh_paths = ["migrations/**"]\n\n' +
      '[profile.accounts]\na1 = "claude"\na2 = "claude"\n\n[profile.agents]\nw1 = "a2"\nr1 = "a1"\n');
  });

  it("update_in_the_middle_keeps_comments_and_other_tables", async () => {
    await run("init", "--no-handbook");
    const base = readCfg(d.home);
    const at = base.indexOf("[review]");
    const text = base.slice(0, at) + '[profile]\ncompute = "one"\npeople = "solo"\n\n' + base.slice(at);
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
    expect(parseToml(now).profile).toEqual({ compute: "one", people: "team", teammates: ["carol"], accounts: {}, agents: {} });
    const { profile: _a, ...rest1 } = parseToml(text);
    const { profile: _b, ...rest2 } = parseToml(now);
    expect(rest2).toEqual(rest1);
  });

  it("dry_run_and_invalid_updates_write_nothing", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "one", "--people", "solo", "--account", "a1=claude");
    const before = readCfg(d.home);
    const [c1, o1] = await run("profile", "update", "--teammate", "carol", "--dry-run");
    expect(c1).toBe(0);
    expect(o1).toBe('[profile]\ncompute = "one"\npeople = "solo"\nteammates = ["carol"]\n\n[profile.accounts]\na1 = "claude"\n\n[profile.agents]\n');
    for (const [argv, msg] of [
      [["--agent", "r9=nope"], "'nope' is not an account"],
      [["--remove-account", "zz"], "no account 'zz' in [profile.accounts]"],
      [["--remove-teammate", "zz"], "'zz' is not in [profile] teammates"],
      [["--account", "bad"], "--account takes NAME=VALUE"],
      [["--max-workers", "-1"], "max_workers must be an integer >= 0"],
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
    expect((await run("profile", "update", "--compute", "one", "--people", "solo", "--account", "a1=claude"))[0]).toBe(0);
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
    await run("profile", "update", "--compute", "multi-vendor", "--people", "solo", "--account", "c1=claude", "--account", "c2=claude",
      "--account", "x1=codex", "--agent", "lead=c1", "--agent", "w1=c2", "--agent", "rx=x1", "--lead-account", "c1", "--high-path", "infra/**");
    const [code, out] = await run("profile", "show");
    expect(code).toBe(0);
    expect(out.split("\n").slice(0, 7)).toEqual([
      "profile: cell C (multi-vendor · solo)",
      "accounts: c1 (claude), c2 (claude), x1 (codex); lead c1",
      "agents: lead=c1, w1=c2, rx=x1",
      "teammates: none",
      "tiers: default=high high_paths=infra/**",
      "low:  review=cross-account teammate=no authority=auto worker_cap=4",
      "high: review=cross-vendor teammate=no authority=owner worker_cap=4",
    ]);
    // no claude or codex CLI on PATH: the vendor rows are missing capabilities
    expect(out).toContain("missing: profile vendor codex: account x1 is on 'codex', but no codex CLI was found and no [agents.codex] is configured");
    const j = JSON.parse((await run("profile", "show", "--json"))[1]);
    expect(Object.keys(j)).toEqual(["cell", "declared_cell", "compute", "effective_compute", "people", "lead_account", "default_tier", "high_paths",
      "teammates", "accounts", "agents", "max_workers", "workers_per_account", "policy", "degraded", "missing"]);
    expect(j.policy.high).toEqual({ need_agent: "cross-vendor", need_teammate: false, authority: "owner", worker_cap: 4 });
    // a degrade shows the declared cell too
    await run("profile", "update", "--account", "x1=claude");
    expect((await run("profile", "show"))[1].split("\n")[0]).toBe("profile: cell B (same-vendor · solo), declared cell C (multi-vendor · solo)");
  });
});

describe("ProfileDoctor", () => {
  const d = useBins();
  const rowsOf = (out: string) => out.split("\n").filter((l) => / {2}profile/.test(l)).map((l) => l.replace(/ {2,}/g, "  "));

  it("missing_capabilities_are_skip_rows", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "same-vendor", "--people", "team", "--account", "a1=codex");
    const [code, out] = await run("doctor");
    expect(code, out).toBe(0);
    expect(rowsOf(out)).toEqual([
      "PASS  profile  cell D (one · team): accounts a1 (codex)",
      "SKIP  profile accounts  same-vendor declared, but only one account is listed in [profile.accounts]; reviews count as single-agent and nothing merges automatically until a second account is added",
      "SKIP  profile vendor codex  account a1 is on 'codex', but no codex CLI was found and no [agents.codex] is configured",
      "SKIP  profile teammates  people = team, but [profile] teammates is empty; high-tier PRs (and every PR in cell D) stay BLOCKED until a login is added",
      "SKIP  profile teammate reviews  teammate approvals are read from GitHub; gh is absent or [merge] repo is unset",
      "PASS  profile agents  0 agent(s) mapped",
    ]);
  });

  it("vendor_and_reviewer_rows", async () => {
    fakeBin(d.bins, "claude");
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "multi-vendor", "--people", "solo", "--account", "a1=claude", "--account", "a2=claude", "--agent", "w1=a1");
    const out = (await run("doctor"))[1];
    expect(rowsOf(out)).toEqual([
      "PASS  profile  cell B (same-vendor · solo): accounts a1, a2 (claude)",
      "PASS  profile accounts  2 accounts",
      "SKIP  profile vendors  multi-vendor declared, but every account is on 'claude'; high-tier PRs get a same-vendor review only and the owner decides",
      "PASS  profile vendor claude  CLI found",
      "SKIP  profile reviewers  every agent in [profile.agents] is on account a1; no review can be cross-account, so low-tier PRs will not merge automatically",
      "SKIP  profile agents  1 agent(s) in [agents.*] have no account in [profile.agents]; their approvals grade as single-agent",
    ]);
  });

  it("fully_backed_profile_is_all_pass", async () => {
    fakeBin(d.bins, "claude");
    fakeBin(d.bins, "codex");
    await run("init", "--no-handbook", "--compute", "multi-vendor", "--people", "solo");
    await run("profile", "update", "--agent", "claude=acct1", "--agent", "codex=acct2");
    const rows = rowsOf((await run("doctor"))[1]);
    expect(rows[0]).toBe("PASS  profile  cell C (multi-vendor · solo): accounts acct1 (claude), acct2 (codex)");
    expect(rows.every((r) => r.startsWith("PASS"))).toBe(true);
    expect(rows.length).toBe(7);
  });

  it("an_invalid_profile_is_a_fail_row_and_exit_2_elsewhere", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + '\n[profile]\ncompute = "two"\npeople = "solo"\n');
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

  it("comments_mode_cell_b_low_passes_and_auto_follows_authority", async () => {
    await setup("--compute", "same-vendor", "--people", "solo", "--account", "acct1=codex", "--account", "acct2=codex", "--agent", "w1=acct2", "--agent", "r1=acct1");
    new Tasks(join(d.home, "tasks")).claim("t1", "w1");
    const base = ["merge-gate", "101", "--fixture", "comment-approved", "--reviews", "comments", "--task", "t1"];
    const summary = "#101 head=4f2c9a1e7 ci=green reviews=comments author=w1 approvals=1/1 [r1] (stale=0 self=0 malformed=0) changes_requested=0 label=off\n";
    expect(await run(...base, "--tier", "low", "--auto")).toEqual([0,
      summary + "profile=B tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=auto\n=> PASS\n", ""]);
    expect(await run(...base, "--auto")).toEqual([1,
      summary + "profile=B tier=high(default) review=cross-account needed=cross-account teammate=n/a authority=owner\n" +
      "=> BLOCKED (--auto: merge authority is owner, not auto)\n", ""]);
    expect((await run(...base))[1].split("\n").at(-2)).toBe("=> PASS (the owner decides the merge)");
  });

  it("github_mode_path_tier_blocks_below_cross_vendor", async () => {
    await setup("--compute", "multi-vendor", "--people", "solo", "--account", "c1=claude", "--account", "c2=claude", "--account", "x1=codex",
      "--agent", "alice=c2", "--agent", "bob=c1", "--agent", "rx=x1", "--high-path", "migrations/**");
    const [code, out] = await run("merge-gate", "101", "--fixture", "high-path");
    expect([code, out]).toEqual([1, "#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=C tier=high(path: migrations/0042_add_index.sql) review=cross-account needed=cross-vendor teammate=n/a authority=owner\n" +
      "=> BLOCKED (review strength cross-account is below cross-vendor)\n"]);
    // no file list in the PR data: high tier
    expect((await run("merge-gate", "101", "--fixture", "approved", "--json"))[1]).toContain('"tier": "high", "tier_source": "files unreadable"');
    const j = JSON.parse((await run("merge-gate", "101", "--fixture", "high-path", "--tier", "low", "--json"))[1]);
    expect(j.ok).toBe(true);
    expect(Object.keys(j.profile)).toEqual(["cell", "declared_cell", "tier", "tier_source", "achieved", "needed", "teammate", "need_teammate",
      "authority", "worker_cap", "degraded", "reasons"]);
    expect(Object.keys(j).slice(0, -1)).toEqual(["head", "ok", "need", "ci_ok", "checks", "label", "label_ok", "approvals", "stale", "self", "changes_requested"]);
  });

  it("teammate_fixtures_under_a_team_profile", async () => {
    await setup("--compute", "same-vendor", "--people", "team", "--teammate", "carol", "--account", "a1=claude", "--account", "a2=claude",
      "--agent", "bob=a1", "--agent", "alice=a2");
    const ok = await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", "high");
    expect(ok).toEqual([0, "#101 head=4f2c9a1e7 ci=green approvals=2/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=E tier=high(flag) review=cross-account needed=cross-account teammate=approved authority=teammate\n" +
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
    expect((await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", "high", "--auto"))[0]).toBe(1);
    expect((await run("merge-gate", "101", "--fixture", "teammate-approved", "--tier", "low", "--auto"))[0]).toBe(0);
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
    expect((await run("profile", "update", "--compute", "same-vendor", "--people", "solo", "--default-tier", "low", "--high-path", "migrations/**",
      "--account", "c1=claude", "--account", "c2=claude", "--agent", "alice=c1", "--agent", "bob=c2"))[0]).toBe(0);
  };

  it("a_path_past_the_first_100_files_is_not_missed", async () => {
    await setup();
    // the paginated list is also cut at 100: the count does not match changedFiles, so the list is unreadable
    fakeGh(files(101).slice(0, 100));
    const [code, out] = await run("merge-gate", "7", "--repo", "o/n", "--auto");
    expect(code).toBe(1);
    expect(out).toContain("profile=B tier=high(files unreadable) review=cross-account needed=cross-account teammate=n/a authority=owner\n");
    expect(out).toContain("=> BLOCKED (--auto: merge authority is owner, not auto)");
    // the full paginated list finds file #101
    fakeGh(files(101));
    const [code2, out2] = await run("merge-gate", "7", "--repo", "o/n", "--auto");
    expect(code2).toBe(1);
    expect(out2).toContain("tier=high(path: migrations/0042_add_index.sql)");
    expect(readFileSync(join(d.bins, "api-argv.txt"), "utf8").split("\n").slice(0, -1)).toEqual(["api", "--paginate", "repos/o/n/pulls/7/files", "--jq", ".[].filename"]);
    // a failed fetch is unreadable too
    fakeGh("fail");
    expect((await run("merge-gate", "7", "--repo", "o/n", "--auto"))[1]).toContain("tier=high(files unreadable)");
    // control: 101 files without a high path, all listed: the default tier (low) holds and auto may merge
    fakeGh(files(100).concat(["src/f100.ts"]));
    const pr = JSON.parse(readFileSync(join(d.bins, "pr.json"), "utf8"));
    expect(pr.changedFiles).toBe(101);
    expect(await run("merge-gate", "7", "--repo", "o/n", "--auto")).toEqual([0, "#7 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off\n" +
      "profile=B tier=low(default) review=cross-account needed=cross-account teammate=n/a authority=auto\n=> PASS\n", ""]);
  });
});

describe("ProfileVendorCase", () => {
  const d = useBins();

  it("vendor_names_differing_in_case_are_one_vendor", async () => {
    await run("init", "--no-handbook");
    writeFileSync(cfgPath(d.home), readCfg(d.home) + '\n[profile]\ncompute = "multi-vendor"\npeople = "team"\nteammates = ["carol"]\n\n' +
      '[profile.accounts]\nc1 = "claude"\nc2 = "Claude"\n\n[profile.agents]\nalice = "c1"\nbob = "c2"\n');
    const [code, out] = await run("merge-gate", "7", "--fixture", "approved", "--tier", "low", "--auto");
    expect(code).toBe(1);
    expect(out).toContain("profile=E tier=low(flag) review=cross-account needed=cross-account teammate=missing authority=teammate degraded=no-second-vendor\n");
    expect(out).toContain("=> BLOCKED (");
    expect((await run("doctor"))[1]).toMatch(/SKIP {2}profile vendors +multi-vendor declared, but every account is on 'claude'/);
  });
});

describe("ProfileWorkers", () => {
  const d = useBins();

  it("worker_start_refuses_at_the_cap_and_force_overrides", async () => {
    await run("init", "--no-handbook");
    await run("profile", "update", "--compute", "one", "--people", "solo");
    const start = (name: string, ...extra: string[]) => run("worker", "start", name, "--workdir", d.home, "--minutes", "0", ...extra, "--", "sleep", "30");
    try {
      expect((await start("w1"))[0]).toBe(0);
      expect(await waitFor(() => readFileSync(join(d.home, "workers", "w1", "PID"), "utf8").trim() !== "")).toBe(true);
      const [code, , err] = await start("w2");
      expect(code).toBe(2);
      expect(err).toBe("worker: 1 worker(s) running and the profile's worker cap is 1 (cell A (one · solo)); stop one, or pass --force\n");
      expect((await start("w2", "--force"))[0]).toBe(0);
    } finally {
      await run("worker", "stop", "w1");
      await run("worker", "stop", "w2");
    }
  });
});
