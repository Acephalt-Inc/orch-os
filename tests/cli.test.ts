// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DIST_CLI, ROOT, run, useTmpHome, waitFor } from "./_helpers.js";

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

  it("test_worker_options_after_name_and_command_after_dashdash", async () => {
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


describe("OwnershipCli", () => {
  const ctx = useTmpHome();
  const binary = (...args: string[]) => spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: "utf8", env: { ...process.env, ORCH_HOME: ctx.home },
  });

  it("built_cli_refuses_damage_names_the_file_and_recovers_epoch_7_to_8", async () => {
    await run("init", "--no-handbook");
    for (let i = 0; i < 7; i++) expect(binary("lease", "acquire", "--session", `s${i}`, "--force").status).toBe(0);
    const path = `${ctx.home}/lease.json`;
    writeFileSync(path, "{broken");
    for (const action of ["status", "acquire", "renew", "release"]) {
      const r = binary("lease", action, "--session", "s6", "--force");
      expect(r.status).toBe(6);
      expect(r.stderr).toContain(path);
      expect(r.stdout).toContain("CORRUPT");
      expect(readFileSync(path, "utf8")).toBe("{broken");
    }
    const recovered = binary("lease", "acquire", "--session", "new", "--recover", "--json");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).state.epoch).toBe(8);
    expect(readFileSync(path + ".recovery.jsonl", "utf8")).toContain('"epoch":8');
    expect(binary("lease", "renew", "--session", "new", "--recover").status).toBe(2);
    // Returning to the same session cannot make an old epoch fence valid again.
    expect(binary("lease", "acquire", "--session", "s6", "--force").status).toBe(0);
    expect(binary("lease", "renew", "--session", "s6", "--expected-epoch", "7").status).toBe(4);
  });

  it("built_task_cli_requires_explicit_journaled_recovery_and_lists_damage", async () => {
    await run("init", "--no-handbook");
    expect(binary("task", "claim", "t1", "--as", "w1").status).toBe(0);
    const path = `${ctx.home}/tasks/t1.json`;
    writeFileSync(path, "null");
    for (const action of ["claim", "renew", "release", "status"]) {
      const args = ["task", action, "t1", ...(action === "status" ? [] : ["--as", "w1"])];
      const r = binary(...args);
      expect(r.status).toBe(6);
      expect(r.stderr).toContain(path);
      expect(readFileSync(path, "utf8")).toBe("null");
    }
    const rows = binary("task", "list", "--json");
    expect(rows.status).toBe(6);
    expect(JSON.parse(rows.stdout)[0].status).toBe("CORRUPT");
    const r = binary("task", "claim", "t1", "--as", "w2", "--recover", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).state).toMatchObject({ epoch: 2, holders: ["w1", "w2"] });
    expect(readFileSync(path + ".recovery.jsonl", "utf8")).toContain('"stage":"COMMITTED"');
    expect(binary("task", "renew", "t1", "--as", "w2", "--recover").status).toBe(2);
  });

  it("unreadable_lock_owner_blocks_cli_even_with_recover", async () => {
    await run("init", "--no-handbook");
    expect(binary("lease", "acquire", "--session", "old").status).toBe(0);
    const path = `${ctx.home}/lease.json`;
    const before = readFileSync(path, "utf8");
    const owner = path + ".lock.d/owner.json";
    mkdirSync(owner, { recursive: true });
    for (const action of ["status", "acquire", "renew", "release"]) {
      const r = binary("lease", action, "--session", "old", ...(action === "acquire" ? ["--recover"] : []));
      expect(r.status).toBe(6);
      expect(r.stderr).toContain(owner);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it.each([
    ["mailbox.md.lock.d", ["mailbox", "post", "LEAD", "-m", "blocked"]],
    ["messages.jsonl.lock.d", ["msg", "send", "DONE", "--to", "w1", "-m", "blocked"]],
    ["cursors/w1.json.lock.d", ["msg", "ack", "--as", "w1", "--all"]],
    ["tasks/t1.json.lock.d", ["task", "claim", "t1", "--as", "w1", "--recover"]],
    ["mem/.lock.d", ["mem", "add", "n1", "--description", "blocked", "-m", "blocked"]],
  ])("unknown_owner_blocks_other_protected_cli_operations: %s", async (lock, args) => {
    await run("init", "--no-handbook");
    const owner = `${ctx.home}/${lock}/owner.json`;
    mkdirSync(owner, { recursive: true });
    const r = binary(...args);
    expect(r.status, r.stdout + r.stderr).toBe(6);
    expect(r.stderr).toContain(owner);
    expect(existsSync(`${ctx.home}/messages.jsonl`)).toBe(false);
    expect(existsSync(`${ctx.home}/tasks/t1.json`)).toBe(false);
    expect(existsSync(`${ctx.home}/cursors/w1.json`)).toBe(false);
    expect(existsSync(`${ctx.home}/mem/n1.md`)).toBe(false);
    expect(readFileSync(`${ctx.home}/mailbox.md`, "utf8")).not.toContain("blocked");
  });

  it("cli_publication_failure_reserves_the_epoch_before_effect", async () => {
    await run("init", "--no-handbook");
    const path = `${ctx.home}/lease.json`;
    mkdirSync(path + ".tmp");
    expect(binary("lease", "acquire", "--session", "failed").status).toBe(1);
    expect(JSON.parse(readFileSync(path + ".epoch.max", "utf8")).epoch).toBe(1);
    expect(existsSync(path)).toBe(false);
    rmSync(path + ".tmp", { recursive: true });
    const r = binary("lease", "acquire", "--session", "next", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).state.epoch).toBe(2);
  });

  it.each([false, true])("a_real_paused_holder_is_safe_and_a_late_write_is_fenced: displaced=%s", async (displaced) => {
    await run("init", "--no-handbook");
    expect(binary("lease", "acquire", "--session", "old").status).toBe(0);
    const path = `${ctx.home}/lease.json`;
    const lock = path + ".lock.d";
    const ready = `${ctx.home}/ready`;
    const resumeWrite = `${ctx.home}/resume-write`;
    const contenderReady = `${ctx.home}/contender-polling`;
    const lockMod = pathToFileURL(join(ROOT, "dist/lock.js")).href;
    const utilMod = pathToFileURL(join(ROOT, "dist/util.js")).href;
    const script = `import fs from "node:fs";
      import { withLock } from ${JSON.stringify(lockMod)};
      import { atomicWrite } from ${JSON.stringify(utilMod)};
      try { withLock(${JSON.stringify(lock)}, () => {
        const state = fs.readFileSync(${JSON.stringify(path)}, "utf8");
        const ownerFile = ${JSON.stringify(lock + "/owner.json")};
        const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
        fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, created_ms: 0 }));
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        const cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 15000;
        while (!fs.existsSync(${JSON.stringify(resumeWrite)})) {
          if (Date.now() > end) throw Error("resume-write timeout");
          Atomics.wait(cell, 0, 0, 5);
        }
        atomicWrite(${JSON.stringify(path)}, state);
      }); } catch (e) { console.error(e.message); process.exitCode = 5; }`;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    holder.stderr.on("data", (chunk) => { err += chunk; });
    const done = new Promise<number | null>((resolve) => holder.on("exit", resolve));
    let contender: ReturnType<typeof spawn> | null = null;
    try {
      expect(await waitFor(() => existsSync(ready))).toBe(true);
      expect(holder.kill("SIGSTOP")).toBe(true); // holder acknowledged readiness and waits for resume-write
      if (!displaced) {
        // A polling acknowledgment proves the contender attempted the held lock.
        const contenderScript = `import fs from "node:fs";
          const wait = Atomics.wait;
          Atomics.wait = function(...args) {
            fs.writeFileSync(${JSON.stringify(contenderReady)}, "polling");
            return wait(...args);
          };
          process.argv = [process.execPath, ${JSON.stringify(DIST_CLI)}, "lease", "acquire", "--session", "new", "--force"];
          await import(${JSON.stringify(pathToFileURL(DIST_CLI).href)});`;
        contender = spawn(process.execPath, ["--input-type=module", "-e", contenderScript], {
          env: { ...process.env, ORCH_HOME: ctx.home }, stdio: "ignore",
        });
        const stopped = new Promise((resolve) => contender!.on("exit", resolve));
        expect(await waitFor(() => existsSync(contenderReady) || contender!.exitCode !== null)).toBe(true);
        expect(existsSync(contenderReady)).toBe(true);
        expect(contender.exitCode).toBe(null); // old alive PID is never broken by the CLI
        expect(JSON.parse(readFileSync(path, "utf8")).epoch).toBe(1);
        contender.kill("SIGTERM"); await stopped;
      } else {
        // Simulate the historical wrongful takeover while the original process is paused.
        rmSync(lock, { recursive: true });
        const acquired = binary("lease", "acquire", "--session", "new", "--force", "--json");
        expect(acquired.status, acquired.stderr).toBe(0);
        expect(JSON.parse(acquired.stdout).state.epoch).toBe(2);
      }
      const before = readFileSync(path, "utf8");
      writeFileSync(resumeWrite, "resume");
      holder.kill("SIGCONT");
      expect(await done, err).toBe(displaced ? 5 : 0);
      expect(readFileSync(path, "utf8")).toBe(before); // old snapshot never overwrites epoch 2
      if (displaced) expect(err).toContain("lock lost while held");
    } finally {
      contender?.kill("SIGTERM");
      if (holder.exitCode === null) { holder.kill("SIGCONT"); holder.kill("SIGKILL"); await done; }
    }
  });
});
