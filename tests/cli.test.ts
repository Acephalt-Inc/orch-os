// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIST_CLI, run, useTmpHome, waitFor } from "./_helpers.js";

describe("CliTest", () => {
  const ctx = useTmpHome();

  it("test_doctor_fails_before_init_passes_after", async () => {
    let [code, out] = await run("doctor");
    expect(code).toBe(1);
    expect(out).toContain("FAIL  config");
    expect((await run("init"))[0]).toBe(0);
    [code, out] = await run("doctor");
    expect(code, out).toBe(0);
    expect(out).toContain("doctor: PASS");
  });

  it("test_malformed_config_is_a_clean_error", async () => {
    await run("init");
    writeFileSync(`${ctx.home}/config.toml`, "x = [");
    expect((await run("lease", "status"))[0]).toBe(2);
    expect((await run("doctor"))[0]).toBe(1);
  });

  it("test_init_is_idempotent", async () => {
    await run("init");
    writeFileSync(`${ctx.home}/config.toml`, readFileSync(`${ctx.home}/config.toml`, "utf8").replace("my-team", "edited"));
    await run("init");
    expect(readFileSync(`${ctx.home}/config.toml`, "utf8")).toContain("edited");
  });

  it("test_lease_mailbox_merge_gate_roundtrip", async () => {
    await run("init");
    expect((await run("lease", "acquire", "--session", "s1"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "s2"))[0]).toBe(3);
    expect((await run("mailbox", "post", "LEAD", "-m", "hello"))[0]).toBe(0);
    expect((await run("mailbox", "read"))[1]).toContain("hello");
    expect((await run("merge-gate", "7", "--fixture", "approved"))[0]).toBe(0);
    const [code, out] = await run("merge-gate", "7", "--fixture", "stale-approval");
    expect(code).toBe(1);
    expect(out).toContain("BLOCKED");
  });

  it.skipIf(process.platform === "win32")("test_worker_options_after_name_and_command_after_dashdash", async () => {
    await run("init");
    const prompt = `${ctx.home}/p.txt`;
    writeFileSync(prompt, "from stdin\n");
    const outFile = `${ctx.home}/got.txt`;
    const [code, out, err] = await run("worker", "start", "w9", "--task", prompt, "--workdir", ctx.home,
      "--minutes", "0", "--", "sh", "-c", `cat > ${outFile}`);
    expect(code, out + err).toBe(0);
    await waitFor(() => existsSync(outFile) && readFileSync(outFile, "utf8") !== "");
    expect(readFileSync(outFile, "utf8")).toBe("from stdin\n");
  });
});

describe("CliV2", () => {
  const ctx = useTmpHome();

  it("mailbox_read_escapes_control_characters_in_timestamps_and_bodies", async () => {
    await run("init", "--no-handbook");
    const p = `${ctx.home}/mailbox.md`;
    writeFileSync(p, readFileSync(p, "utf8").replace("## LEAD\n",
      "## LEAD\n### 2026-01-01T00:00:00\u001b[2K\u202e (LEAD)\nplain\u0007 text\n<!-- id: " + "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) + " -->\n\n"));
    const [code, out] = await run("mailbox", "read");
    expect(code).toBe(0);
    expect(out).toContain("--- 2026-01-01T00:00:00\\x1b[2K\\u202e (LEAD)\nplain\\x07 text");
    expect(out).not.toMatch(/[\u001b\u202e\u0007]/);
  });

  it("doctor_reports_a_bad_config_value_as_a_fail_row_not_an_abort", async () => {
    await run("init", "--no-handbook");
    const p = `${ctx.home}/config.toml`;
    writeFileSync(p, readFileSync(p, "utf8").replace("index_max_lines = 200", 'index_max_lines = "many"').replace("timeout_minutes = 60", 'timeout_minutes = "60"'));
    const [code, out] = await run("doctor");
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}mem +\[mem\] index_max_lines must be a number/);
    expect(out).toMatch(/PASS {2}task registry/);
    expect(out).not.toMatch(/FAIL {2}worker limits/); // "60" is a numeric string: accepted
    expect(out).toContain("doctor: FAIL (1 required check(s) failed)");
  });

  it("non_numeric_durations_in_config_exit_2_and_never_reach_the_lease_file", async () => {
    await run("init", "--no-handbook");
    const p = `${ctx.home}/config.toml`;
    writeFileSync(p, readFileSync(p, "utf8").replace("default_seconds = 3600", 'default_seconds = "soon"'));
    const [code, , err] = await run("lease", "acquire", "--session", "a");
    expect(code).toBe(2);
    expect(err).toContain("[lease] default_seconds must be a number");
    expect(existsSync(`${ctx.home}/lease.json`)).toBe(false);
  });

  it("usage_errors_exit_2_help_exits_0_version_prints", async () => {
    expect((await run("nope"))[0]).toBe(2);
    expect((await run("lease", "grab"))[0]).toBe(2);
    expect((await run("lease", "acquire", "--seconds", "soon"))[0]).toBe(2);
    expect((await run("mailbox"))[0]).toBe(2);
    const [code, out] = await run("lease", "--help");
    expect(code).toBe(0);
    expect(out).toContain("--expected-epoch");
    expect((await run("--version"))[1]).toMatch(/^orch \d+\.\d+\.\d+\n$/);
  });

  it("lease_json_output_and_expected_epoch_release", async () => {
    await run("init");
    const [, out] = await run("lease", "acquire", "--session", "s1", "--json");
    const r = JSON.parse(out);
    expect(r).toMatchObject({ action: "acquire", status: "ACQUIRED", lease_seconds_raised: false });
    expect(Object.keys(r)).toEqual(["action", "now", "holder", "unexpired", "epoch", "expires_at", "state", "lease_seconds_raised", "status"]);
    expect((await run("lease", "release", "--session", "s1", "--expected-epoch", "5"))[0]).toBe(4);
    expect((await run("lease", "release", "--session", "s1", "--expected-epoch", "1"))[0]).toBe(0);
  });

  it("merge_gate_blocks_on_unreadable_fixture_and_honours_head_guard", async () => {
    await run("init");
    writeFileSync(`${ctx.home}/bad.json`, '{"headRefOid": 5}');
    let [code, out] = await run("merge-gate", "1", "--fixture", `${ctx.home}/bad.json`);
    expect([code, out]).toEqual([1, "#1 => BLOCKED (unreadable PR data: headRefOid is not a string)\n"]);
    [code, out] = await run("merge-gate", "1", "--fixture", "no-such-fixture");
    expect(code).toBe(1);
    expect(out).toContain("=> BLOCKED (");
    [code, out] = await run("merge-gate", "1", "--fixture", "approved", "--head", "0".repeat(40));
    expect(code).toBe(1);
    expect(out).toContain("head moved");
  });

  it("mailbox_post_reads_stdin_when_no_message", async () => {
    await run("init");
    const r = spawnSync(process.execPath, [DIST_CLI, "mailbox", "post", "WORKER", "--author", "w1"], {
      input: "from a pipe\n", encoding: "utf8", env: { ...process.env, ORCH_HOME: ctx.home },
    });
    expect(r.status, r.stderr).toBe(0);
    expect((await run("mailbox", "read", "--section", "worker"))[1]).toContain("from a pipe");
  });

  it("the_built_binary_runs_and_exits_with_the_command_code", () => {
    const env = { ...process.env, ORCH_HOME: ctx.home };
    expect(spawnSync(process.execPath, [DIST_CLI, "init", "--no-handbook"], { env }).status).toBe(0);
    expect(spawnSync(process.execPath, [DIST_CLI, "lease", "acquire", "--session", "a"], { env }).status).toBe(0);
    expect(spawnSync(process.execPath, [DIST_CLI, "lease", "acquire", "--session", "b"], { env }).status).toBe(3);
    expect(spawnSync(process.execPath, [DIST_CLI, "lease", "renew", "--session", "b"], { env }).status).toBe(4);
  });
});
