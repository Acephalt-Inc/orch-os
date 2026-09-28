// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as C from "../src/config.js";
import { parseToml } from "../src/toml.js";
import { groupAlive, WorkerError, Workers } from "../src/workers.js";
import { sleep } from "../src/util.js";
import { useTmpHome, waitFor } from "./_helpers.js";

describe("WorkersTest", () => {
  const ctx = useTmpHome();
  const workers = () => new Workers(parseToml(C.renderDefault(ctx.home)), `${ctx.home}/workers`, `${ctx.home}/load.json`);

  it("test_start_list_stop", async () => {
    const w = workers();
    w.start("w1", { command: ["sh", "-c", "echo hello {name}; sleep 30"], workdir: ctx.home, minutes: 1 });
    expect(w.list()[0].state).toBe("RUNNING");
    const log = `${ctx.home}/workers/w1/stdout.log`;
    await waitFor(() => readFileSync(log, "utf8").includes("hello"));
    expect(() => w.start("w1", { command: ["sleep", "1"] })).toThrow(WorkerError);
    const r = await w.stop("w1");
    expect(["TERMINATED", "KILLED"]).toContain(r.result);
    await sleep(200);
    expect(w.list()[0].state).toBe("STOPPED");
    expect(readFileSync(log, "utf8")).toContain("hello w1");
  });

  it("test_high_load_blocks_start_unless_forced", async () => {
    writeFileSync(`${ctx.home}/load.json`, JSON.stringify({ tier: "HIGH" }));
    const w = workers();
    expect(() => w.start("w2", { command: ["sleep", "1"], workdir: ctx.home })).toThrow(WorkerError);
    w.start("w2", { command: ["sleep", "1"], workdir: ctx.home, force: true });
    await w.stop("w2");
  });

  it("test_bad_name_and_missing_command", () => {
    const w = workers();
    expect(() => w.start("../x", { command: ["true"] })).toThrow(WorkerError);
    expect(() => w.start("w3", { command: ["definitely-not-a-command-xyz"], workdir: ctx.home })).toThrow(WorkerError);
  });

  it("test_stop_refuses_a_reused_pid", async () => {
    const w = workers();
    w.start("w4", { command: ["sleep", "30"], workdir: ctx.home });
    const metaPath = `${ctx.home}/workers/w4/worker.json`;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const real = meta.proc_start;
    meta.proc_start = "Thu Jan  1 00:00:00 1970";
    writeFileSync(metaPath, JSON.stringify(meta));
    expect((await w.stop("w4")).result).toBe("PID_REUSED");
    expect(w.list()[0].state).toBe("RUNNING");
    meta.proc_start = real;
    writeFileSync(metaPath, JSON.stringify(meta));
    expect(["TERMINATED", "KILLED"]).toContain((await w.stop("w4")).result);
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("WorktreeV2", () => {
  const ctx = useTmpHome();
  const setup = () => {
    const repo = `${ctx.home}/repo`;
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "trunk");
    writeFileSync(`${repo}/a.txt`, "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    const cfg = parseToml(C.renderDefault(ctx.home));
    const w = new Workers(cfg, `${ctx.home}/workers`, `${ctx.home}/load.json`);
    return { repo, w, root: realpathSync(ctx.home) + "/worktrees" };
  };

  it("start_creates_a_worktree_on_its_own_branch_and_runs_there", async () => {
    const { repo, w, root } = setup();
    const m = w.start("w1", { command: ["sh", "-c", "pwd > where.txt; git rev-parse --abbrev-ref HEAD >> where.txt"], workdir: repo, worktree: true, minutes: 0 });
    expect(m.worktree).toMatchObject({ path: `${root}/w1`, branch: "orch/w1", created: true });
    expect(m.workdir).toBe(`${root}/w1`);
    expect(await waitFor(() => existsSync(`${root}/w1/where.txt`) && readFileSync(`${root}/w1/where.txt`, "utf8").split("\n").length > 2)).toBe(true);
    expect(readFileSync(`${root}/w1/where.txt`, "utf8")).toContain("orch/w1");
    expect(git(repo, "worktree", "list")).toContain(`${root}/w1`);
  });

  it("stop_removes_a_clean_worktree_and_keeps_the_branch", async () => {
    const { repo, w, root } = setup();
    w.start("w1", { command: ["sleep", "30"], workdir: repo, worktree: true });
    const r = await w.stop("w1");
    expect(r.worktree).toContain("worktree removed");
    expect(existsSync(`${root}/w1`)).toBe(false);
    expect(git(repo, "branch", "--list", "orch/w1")).toContain("orch/w1");
  });

  it("stop_keeps_a_dirty_worktree", async () => {
    const { repo, w, root } = setup();
    w.start("w2", { command: ["sh", "-c", "echo change > new.txt; sleep 30"], workdir: repo, worktree: true });
    await waitFor(() => existsSync(`${root}/w2/new.txt`));
    const r = await w.stop("w2");
    expect(r.worktree).toContain("dirty: 1 changed, 0 ignored path(s)");
    expect(existsSync(`${root}/w2/new.txt`)).toBe(true);
  });

  it("stop_keeps_a_worktree_that_holds_only_ignored_files", async () => {
    const { repo, w, root } = setup();
    writeFileSync(`${repo}/.gitignore`, "*.env\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "ignore env files");
    w.start("w3", { command: ["sh", "-c", "echo x=1 > local.env; sleep 30"], workdir: repo, worktree: true });
    await waitFor(() => existsSync(`${root}/w3/local.env`));
    const r = await w.stop("w3");
    expect(r.worktree).toContain("dirty: 0 changed, 1 ignored path(s)");
    expect(existsSync(`${root}/w3/local.env`)).toBe(true);
  });

  it("stop_kills_group_members_that_ignore_sigterm_before_touching_the_worktree", async () => {
    const { repo, w, root } = setup();
    // the leader exits on SIGTERM; a child that ignores TERM would keep the group alive
    w.start("w4", { command: ["sh", "-c", "(trap '' TERM; sleep 30) & wait"], workdir: repo, worktree: true, minutes: 0 });
    await new Promise((res) => setTimeout(res, 300));
    const r = await w.stop("w4", 300);
    expect(groupAlive(r.pid)).toBe(false);
    expect(r.result).toBe("KILLED");
    expect(r.worktree).toContain("worktree removed");
    expect(existsSync(`${root}/w4`)).toBe(false);
  });

  it("stop_reaches_members_left_behind_after_the_leader_exited", async () => {
    const { w } = setup();
    // the leader exits at once; its background child stays in the group
    const m = w.start("w6", { command: ["sh", "-c", "sleep 30 & exit 0"], minutes: 0 });
    expect(await waitFor(() => { try { process.kill(m.pid, 0); return false; } catch { return true; } })).toBe(true);
    expect(w.list().find((x) => x.name === "w6")?.state).toBe("RUNNING");
    expect(() => w.start("w6", { command: ["true"] })).toThrow(/still running/);
    const r = await w.stop("w6", 1000);
    expect(r.result).toBe("TERMINATED");
    expect(groupAlive(m.pid)).toBe(false);
    expect((await w.stop("w6")).result).toBe("NOT_RUNNING");
    expect(w.list().find((x) => x.name === "w6")?.state).toBe("STOPPED");
  });

  it("non_numeric_worker_limits_are_config_errors", () => {
    const { repo } = setup();
    for (const [k, v] of [["timeout_minutes", "soon"], ["nice", "low"]]) {
      const cfg = parseToml(C.renderDefault(ctx.home));
      cfg.workers[k] = v;
      const w = new Workers(cfg, `${ctx.home}/workers`, `${ctx.home}/load.json`);
      expect(() => w.start(`bad-${k}`, { command: ["true"], workdir: repo })).toThrow(C.ConfigError);
    }
    const bad = parseToml(C.renderDefault(ctx.home));
    bad.workers.nice = "low";
    expect(() => new Workers(bad, `${ctx.home}/workers`, `${ctx.home}/load.json`).start("wt-bad", { command: ["true"], workdir: repo, worktree: true })).toThrow(C.ConfigError);
    expect(existsSync(`${realpathSync(ctx.home)}/worktrees/wt-bad`)).toBe(false); // nothing created before the check
    expect(git(repo, "branch", "--list", "orch/wt-bad")).toBe("");
    const cfg = parseToml(C.renderDefault(ctx.home));
    cfg.workers.timeout_minutes = "0";
    expect(new Workers(cfg, `${ctx.home}/workers`, `${ctx.home}/load.json`).start("ok", { command: ["true"], workdir: repo }).pid).toBeGreaterThan(1);
  });

  it("base_and_branch_cannot_smuggle_git_options", () => {
    const { repo, w } = setup();
    expect(() => w.start("w5", { command: ["true"], workdir: repo, worktree: true, base: "--force" })).toThrow(/not a commit/);
    expect(() => w.start("w5", { command: ["true"], workdir: repo, worktree: true, base: "no-such-ref" })).toThrow(/not a commit/);
    expect(() => w.start("w5", { command: ["true"], workdir: repo, worktree: true, branch: "--force" })).toThrow(/bad branch/);
  });

  it("a_live_pid_whose_start_time_cannot_be_read_is_never_signalled", async () => {
    const { w } = setup();
    const m = w.start("w7", { command: ["sleep", "30"], minutes: 0 });
    const meta = JSON.parse(readFileSync(`${ctx.home}/workers/w7/worker.json`, "utf8"));
    const ps = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
    expect(meta.proc_start).toBeTruthy();
    // hide ps: procStart() returns null, pidAlive() still sees the process through kill(0)
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    let r: Record<string, any>;
    try {
      r = await w.stop("w7", 500);
    } finally {
      process.env.PATH = saved;
    }
    expect(ps).not.toBe("");
    expect(r.result).toBe("PID_REUSED");
    let alive = true;
    try { process.kill(m.pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    expect((await w.stop("w7", 2000)).result).toBe("TERMINATED");
  });

  it("a_pid_file_of_1_or_less_is_never_signalled", async () => {
    const { w } = setup();
    for (const t of ["1", "0", "-1", "-4242"]) {
      mkdirSync(`${ctx.home}/workers/bad`, { recursive: true });
      writeFileSync(`${ctx.home}/workers/bad/PID`, t);
      expect(w.pid("bad")).toBeNull();
      expect((await w.stop("bad")).result).toBe("NOT_RUNNING");
    }
  });

  it("an_existing_worktree_is_attached_and_never_removed", async () => {
    const { repo, w, root } = setup();
    mkdirSync(root, { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "mine", `${root}/w3`);
    const m = w.start("w3", { command: ["sleep", "30"], workdir: repo, worktree: true });
    expect(m.worktree).toMatchObject({ created: false, branch: "mine" });
    const r = await w.stop("w3");
    expect(r.worktree).toContain("attached, not created by orch");
    expect(existsSync(`${root}/w3`)).toBe(true);
  });

  it("existing_branch_is_checked_out_and_base_is_honoured", async () => {
    const { repo, w, root } = setup();
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(`${repo}/b.txt`, "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "second");
    w.start("w4", { command: ["true"], workdir: repo, worktree: true, base: first, minutes: 0 });
    expect(git(`${root}/w4`, "rev-parse", "HEAD")).toBe(first);
    await w.stop("w4");
    git(repo, "branch", "feature");
    const m = w.start("w5", { command: ["true"], workdir: repo, worktree: true, branch: "feature", minutes: 0 });
    expect(m.worktree).toMatchObject({ branch: "feature", created: true });
  });

  it("refuses_non_repo_foreign_dir_bad_branch_and_branch_without_worktree", () => {
    const { repo, w, root } = setup();
    mkdirSync(`${ctx.home}/plain`);
    expect(() => w.start("w6", { command: ["true"], workdir: `${ctx.home}/plain`, worktree: true })).toThrow(/needs a git repository/);
    mkdirSync(`${root}/w7`, { recursive: true });
    expect(() => w.start("w7", { command: ["true"], workdir: repo, worktree: true })).toThrow(/not a worktree/);
    expect(() => w.start("w8", { command: ["true"], workdir: repo, worktree: true, branch: "bad..name" })).toThrow(/bad branch name/);
    expect(() => w.start("w9", { command: ["true"], workdir: repo, branch: "x" })).toThrow(/need --worktree/);
  });

  it("keep_worktree_flag_keeps_even_a_clean_one", async () => {
    const { repo, w, root } = setup();
    w.start("w10", { command: ["sleep", "30"], workdir: repo, worktree: true });
    const r = await w.stop("w10", 5000, true);
    expect(r.worktree).toContain("--keep-worktree");
    expect(existsSync(`${root}/w10`)).toBe(true);
  });
});
