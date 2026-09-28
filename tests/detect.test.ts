// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Agent detection, `orch init` / `orch doctor` / `orch agents` with and without agent CLIs. */
import { appendFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/detect.js";
import { parseToml } from "../src/toml.js";
import { fakeBin, keepEnv, run, tmp, useTmpHome, waitFor } from "./_helpers.js";

/** PATH = one temp dir of fake agents (+ /bin:/usr/bin for sh/git); fallback dirs = one other temp dir. */
function useDetectBase() {
  const ctx = useTmpHome();
  const d = { bins: "", off: "", get home() { return ctx.home; } };
  keepEnv(["PATH", "ORCH_AGENT_DIRS"]);
  beforeEach(() => {
    d.bins = tmp("orch-bins-");
    d.off = tmp("orch-off-");
    process.env.PATH = `${d.bins}:/usr/bin:/bin`;
    process.env.ORCH_AGENT_DIRS = d.off;
  });
  afterEach(() => {
    rmSync(d.bins, { recursive: true, force: true });
    rmSync(d.off, { recursive: true, force: true });
  });
  return d;
}

const cfgOf = (home: string) => parseToml(readFileSync(`${home}/config.toml`, "utf8"));

describe("DetectTest", () => {
  const d = useDetectBase();

  it("test_nothing_installed", () => {
    expect(D.installed()).toEqual([]);
    expect(D.detect().map((r) => r.name)).toEqual(D.KNOWN.map((k) => k[0]));
  });

  it("test_path_hit_uses_absolute_path_and_template", () => {
    fakeBin(d.bins, "codex");
    const [a, ...rest] = D.installed();
    expect(rest).toEqual([]);
    expect(a.name).toBe("codex");
    expect(a.on_path).toBe(true);
    expect(a.command).toEqual([`${d.bins}/codex`, "exec", "-"]);
  });

  it("test_non_executable_is_ignored", () => {
    writeFileSync(`${d.bins}/claude`, "not a program");
    expect(D.installed()).toEqual([]);
  });

  it("test_fallback_dir_found_off_path", () => {
    fakeBin(d.off, "claude");
    const [a, ...rest] = D.installed();
    expect(rest).toEqual([]);
    expect([a.name, a.on_path, a.path]).toEqual(["claude", false, `${d.off}/claude`]);
  });

  it("test_fallback_can_be_disabled", () => {
    fakeBin(d.off, "claude");
    process.env.ORCH_AGENT_DIRS = "";
    expect(D.installed()).toEqual([]);
  });

  it("test_preference_order", () => {
    for (const n of ["qwen", "codex", "claude"]) fakeBin(d.bins, n);
    expect(D.installed().map((a) => a.name)).toEqual(["claude", "codex", "qwen"]);
  });
});

describe("InitDoctorTest", () => {
  const d = useDetectBase();

  it("test_fresh_machine_without_agents_is_green", async () => {
    let [code, out, err] = await run("init");
    expect(code, out + err).toBe(0);
    expect(out).toContain("agents: none of");
    expect(cfgOf(d.home).workers.command).toEqual([]);
    expect(cfgOf(d.home)).not.toHaveProperty("agents");
    [code, out, err] = await run("doctor");
    expect(code, out + err).toBe(0);
    expect(out).toContain("SKIP  agent CLIs");
    expect(out).toContain("doctor: PASS");
  });

  it("test_init_writes_detected_agents_and_default", async () => {
    fakeBin(d.bins, "claude");
    fakeBin(d.bins, "codex");
    let [code, out] = await run("init");
    expect(code, out).toBe(0);
    expect(out).toContain("<- default worker agent");
    const cfg = cfgOf(d.home);
    expect(Object.keys(cfg.agents).sort()).toEqual(["claude", "codex"]);
    expect(cfg.workers.command).toEqual([`${d.bins}/claude`, "-p"]);
    [code, out] = await run("doctor");
    expect(code, out).toBe(0);
    expect(out).toContain("PASS  agent CLIs");
    expect(out).toContain("PASS  agent codex");
  });

  it("test_init_agent_flag_picks_default", async () => {
    fakeBin(d.bins, "claude");
    fakeBin(d.bins, "codex");
    expect((await run("init", "--agent", "codex"))[0]).toBe(0);
    expect(cfgOf(d.home).workers.command[0]).toBe(`${d.bins}/codex`);
  });

  it("test_init_unknown_agent_is_refused_and_writes_nothing", async () => {
    fakeBin(d.bins, "codex");
    const [code, out, err] = await run("init", "--agent", "gemini");
    expect(code).toBe(2);
    expect(out + err).toContain("not found");
    expect(existsSync(`${d.home}/config.toml`)).toBe(false);
  });

  it("test_init_keeps_existing_config_until_force", async () => {
    await run("init");
    fakeBin(d.bins, "codex");
    await run("init");
    expect(cfgOf(d.home)).not.toHaveProperty("agents");
    await run("init", "--force");
    expect(cfgOf(d.home).agents).toHaveProperty("codex");
  });

  it("test_doctor_flags_configured_agent_that_disappeared", async () => {
    const b = fakeBin(d.bins, "codex");
    await run("init");
    unlinkSync(b);
    const [code, out] = await run("doctor");
    expect(code, out).toBe(0); // optional: workers can still take a command after --
    expect(out).toContain("SKIP  agent codex");
  });

  it("test_agents_command_lists_known_and_custom", async () => {
    fakeBin(d.bins, "codex");
    await run("init");
    appendFileSync(`${d.home}/config.toml`, '\n[agents.mine]\ncommand = ["/bin/cat"]\n');
    const [code, out] = await run("agents");
    expect(code).toBe(0);
    expect(out).toMatch(/codex\s+found\s+configured/);
    expect(out).toMatch(/claude\s+absent/);
    expect(out).toMatch(/mine\s+custom\s+configured/);
  });

  it("test_worker_start_with_agent_feeds_task_on_stdin", async () => {
    fakeBin(d.bins, "codex", 'cat > "$1.out"'); // argv: exec -  => "$1"="exec"
    await run("init");
    const prompt = `${d.home}/task.md`;
    writeFileSync(prompt, "fix the parser\n");
    const [code, out, err] = await run("worker", "start", "w1", "--agent", "codex", "--task", prompt,
      "--workdir", d.home, "--minutes", "0");
    expect(code, out + err).toBe(0);
    const target = `${d.home}/exec.out`;
    await waitFor(() => existsSync(target) && readFileSync(target, "utf8") !== "");
    expect(readFileSync(target, "utf8")).toBe("fix the parser\n");
    expect((await run("worker", "start", "w2", "--agent", "gemini"))[0]).toBe(2);
    expect((await run("worker", "start", "w3", "--agent", "codex", "--", "true"))[0]).toBe(2);
  });
});
