// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Workers: detached agent processes, one state directory each.
 *
 * start = a detached child in a new session (its own process group), optionally wrapped in
 *         `timeout` and `nice`, task file on stdin, stdout/stderr into the worker's directory,
 *         pid recorded in <root>/<name>/PID. Refused while the load tier is in block_tiers.
 *         New in v2: with `worktree`, the worker runs in its own git worktree (created on a
 *         branch, or attached if that worktree already exists).
 * list  = every worker directory with RUNNING / STOPPED / UNKNOWN.
 * stop  = SIGTERM to the process group, SIGKILL to it after a grace period, until every member
 *         (not just the leader) is gone. A worktree that orch
 *         created is then removed, but only when the whole process group has exited and
 *         `git status --porcelain --untracked-files=all --ignored` shows nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ConfigError, configNumber } from "./config.js";
import * as RD from "./readiness.js";
import * as loadmod from "./load.js";
import { dumps } from "./pyjson.js";
import { expandPath, pidAlive, sleep, which } from "./util.js";

export class WorkerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WorkerError";
  }
}

/** Kernel start time of pid as printed by ps, or null. Tells a worker from a later pid reuse. */
export function procStart(pid: number): string | null {
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return (out.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

function git(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (r.error) return { code: 127, out: "", err: String(r.error.message) };
  return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface Worktree {
  path: string;
  repo: string;
  branch: string | null;
  created: boolean;
}

export interface StartOptions {
  command?: string[] | null;
  task?: string | null;
  workdir?: string | null;
  minutes?: number | null;
  force?: boolean;
  agent?: string | null;
  reviewer?: string | null;
  worktree?: boolean;
  branch?: string | null;
  base?: string | null;
  /** extra environment variables for the worker (added to this process's environment) */
  env?: Record<string, string>;
}

export class Workers {
  readonly cfg: Record<string, any>;
  readonly agents: Record<string, any>;
  constructor(readonly fullConfig: Record<string, any>, readonly root: string, readonly loadState: string) {
    const cfg = fullConfig;
    this.cfg = cfg.workers ?? {};
    this.agents = cfg.agents ?? {};
  }

  dir(name: string): string {
    if (!name || name.includes("/") || name.startsWith(".")) throw new WorkerError(`bad worker name '${name}'`);
    return `${this.root}/${name}`;
  }

  pid(name: string): number | null {
    try {
      const t = readFileSync(`${this.dir(name)}/PID`, "utf8").trim();
      if (!/^[+-]?\d+$/.test(t)) return null;
      const p = parseInt(t, 10);
      // 0, 1 and negative values are never a worker: kill(-1) would signal every process we own
      return p > 1 ? p : null;
    } catch (e) {
      if (e instanceof WorkerError) throw e;
      return null;
    }
  }

  meta(name: string): Record<string, any> {
    try {
      const v = JSON.parse(readFileSync(`${this.dir(name)}/worker.json`, "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  worktreeRoot(): string {
    return expandPath(String(this.cfg.worktree_root ?? `${this.root}/../worktrees`));
  }

  /** Create or attach the worker's git worktree; returns its record. */
  prepareWorktree(name: string, repoDir: string, branch?: string | null, base?: string | null): Worktree {
    const top = git(["rev-parse", "--show-toplevel"], repoDir);
    if (top.code !== 0) throw new WorkerError(`--worktree needs a git repository: ${repoDir} (${top.err || "not a repo"})`);
    const repo = realOrResolve(top.out.trim());
    const root = this.worktreeRoot();
    mkdirSync(root, { recursive: true });
    const path = `${realOrResolve(root)}/${name}`;
    const br = branch || `${this.cfg.worktree_branch_prefix ?? "orch/"}${name}`;
    if (git(["check-ref-format", "--branch", br], repo).code !== 0) throw new WorkerError(`bad branch name '${br}'`);
    if (br.startsWith("-")) throw new WorkerError(`bad branch name '${br}'`);
    if (base && (base.startsWith("-") || git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repo).code !== 0)) {
      throw new WorkerError(`--base ${base}: not a commit in ${repo}`);
    }
    const list = git(["worktree", "list", "--porcelain"], repo);
    const registered = list.out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realOrResolve(l.slice(9)));
    if (existsSync(path)) {
      if (!registered.includes(path)) throw new WorkerError(`${path} exists but is not a worktree of ${repo}`);
      const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], path).out.trim();
      return { path, repo, branch: cur || null, created: false };
    }
    const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${br}`], repo).code === 0;
    const args = exists ? ["worktree", "add", path, br] : ["worktree", "add", "-b", br, path, base || "HEAD"];
    const r = git(args, repo);
    if (r.code !== 0) throw new WorkerError(`git worktree add failed: ${r.err}`);
    return { path, repo, branch: br, created: true };
  }

  /** Remove a worktree orch created, only if it is clean. Returns a one-line outcome. */
  cleanupWorktree(wt: Worktree | undefined | null, keep = false): string | null {
    if (!wt || !wt.path) return null;
    if (!existsSync(wt.path)) return `worktree gone ${wt.path}`;
    if (keep) return `worktree kept ${wt.path} (--keep-worktree)`;
    if (!wt.created) return `worktree kept ${wt.path} (attached, not created by orch)`;
    // --ignored too: `git worktree remove` deletes ignored files (.env, notes, build output)
    const st = git(["status", "--porcelain", "--untracked-files=all", "--ignored"], wt.path);
    if (st.code !== 0) return `worktree kept ${wt.path} (git status failed: ${st.err})`;
    const lines = st.out.split("\n").filter((l) => l.trim());
    const ignored = lines.filter((l) => l.startsWith("!!")).length;
    const dirty = lines.length - ignored;
    if (dirty || ignored) return `worktree kept ${wt.path} (dirty: ${dirty} changed, ${ignored} ignored path(s))`;
    const r = git(["worktree", "remove", wt.path], wt.repo);
    if (r.code !== 0) return `worktree kept ${wt.path} (git worktree remove failed: ${r.err})`;
    return `worktree removed ${wt.path} (branch ${wt.branch} kept)`;
  }

  start(name: string, opts: StartOptions = {}): Record<string, any> {
    const d = this.dir(name);
    const p = this.pid(name);
    if (p && pidAlive(p)) throw new WorkerError(`worker ${name} already running (pid ${p})`);
    if (p && groupAlive(p)) throw new WorkerError(`worker ${name}: processes of its last run are still running (group ${p}); run \`orch worker stop ${name}\` first`);
    // config values first: nothing (directory, worktree, branch) is created if they are bad
    let minutes: number;
    try { minutes = opts.minutes ?? configNumber(this.cfg.timeout_minutes, 60, "[workers] timeout_minutes"); }
    catch (e: any) { throw new ConfigError(`time limit: ${e.message}`); }
    const nice = Math.trunc(configNumber(this.cfg.nice, 5, "[workers] nice", -20));
    const tier = loadmod.readState(this.loadState).tier ?? "NORMAL";
    if (opts.agent && opts.command && opts.command.length) throw new WorkerError("pass --agent or a command after --, not both");
    let tmpl: string[];
    if (opts.agent) {
      if (!Object.hasOwn(this.agents, opts.agent)) {
        throw new WorkerError(`no [agents.${opts.agent}] in config (configured: ${Object.keys(this.agents).sort().join(", ") || "none"}; run \`orch init --force\`)`);
      }
      tmpl = this.agents[opts.agent].command ?? [];
    } else {
      tmpl = opts.command && opts.command.length ? opts.command : this.cfg.command ?? [];
    }
    if (!Array.isArray(tmpl) || tmpl.some((v) => typeof v !== "string")) throw new WorkerError("worker command must be an argv array of strings");
    if (!tmpl.length) throw new WorkerError("no worker command: set [workers] command, use --agent, or pass one after --");
    let wd = realOrResolve(opts.workdir ?? process.cwd());
    if (!existsSync(wd) || !statSync(wd).isDirectory()) throw new WorkerError(`workdir is not a directory: ${wd}`);
    // A command tied to a not-yet-created worktree cannot be verified before admission.
    const commandDir = opts.worktree ? `${realOrResolve(this.worktreeRoot())}/${name}` : wd;
    const probe = tmpl.map((a) => String(a).replaceAll("{name}", name).replaceAll("{workdir}", commandDir));
    if (probe[0].includes("/")) probe[0] = resolve(commandDir, probe[0]);
    const commandBin = which(probe[0]);
    if (opts.force && process.stdin.isTTY !== true) throw new WorkerError("--force is for attended use only; requires a terminal on stdin");
    if (opts.force) {
      process.stderr.write("WARNING: attended --force bypasses readiness and load admission\n");
    } else {
      const checks = RD.readiness(this.fullConfig, this.loadState, {
        ...opts, command: probe, agent: undefined, workerIdentity: opts.agent ?? Object.keys(this.agents).find((n) => JSON.stringify(this.agents[n].command) === JSON.stringify(tmpl)), workdir: wd, commandWorkdir: commandDir, name,
        reviewer: opts.reviewer ?? (opts.env?.ORCH_REVIEW_PR ? opts.env.ORCH_AGENT : undefined),
      });
      const failing = checks.filter((c) => !c.ok);
      if (failing.length) throw new WorkerError(`readiness failed: ${failing.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    }
    if (!commandBin) throw new WorkerError(`worker command not found on PATH: ${probe[0]}`);
    const to = which("timeout") ?? which("gtimeout");
    if (!opts.force && (!to || RD.timeLimitProblem(minutes))) throw new WorkerError("readiness failed: timeout or time limit changed before launch");
    mkdirSync(d, { recursive: true });
    let wt: Worktree | null = null;
    if (opts.worktree) {
      wt = this.prepareWorktree(name, wd, opts.branch, opts.base);
      wd = wt.path;
    } else if (opts.branch || opts.base) {
      throw new WorkerError("--branch and --base need --worktree");
    }
    let argv = tmpl.map((a) => String(a).replaceAll("{name}", name).replaceAll("{workdir}", wd));
    argv[0] = commandBin; // use the executable resolved for the actual child working directory
    if (minutes > 0 && to) argv = [to, String(Math.trunc(minutes * 60)), ...argv];
    const niceBin = which("nice");
    if (nice > 0 && niceBin) argv = [niceBin, "-n", String(nice), ...argv];
    let fin = -1;
    let fo = -1;
    let fe = -1;
    let pid: number | undefined;
    try {
      fin = openSync(opts.task ? opts.task : "/dev/null", "r");
      fo = openSync(`${d}/stdout.log`, "a");
      fe = openSync(`${d}/stderr.log`, "a");
      const child = spawn(argv[0], argv.slice(1), { cwd: wd, stdio: [fin, fo, fe], detached: true, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
      child.on("error", () => { /* reported through the missing pid below */ });
      pid = child.pid;
      child.unref();
    } catch (e: any) {
      if (wt?.created) this.cleanupWorktree(wt);
      throw new WorkerError(`could not start worker: ${e.message ?? e}`);
    } finally {
      for (const fd of [fin, fo, fe]) if (fd >= 0) closeSync(fd);
    }
    if (!pid) {
      if (wt?.created) this.cleanupWorktree(wt);
      throw new WorkerError(`could not start worker: ${argv[0]}`);
    }
    writeFileSync(`${d}/PID`, String(pid));
    const meta: Record<string, any> = {
      name, pid, argv, workdir: wd, started_at: Date.now() / 1000,
      timeout_minutes: to ? minutes : null, load_tier: tier, proc_start: procStart(pid),
    };
    if (wt) meta.worktree = wt;
    writeFileSync(`${d}/worker.json`, dumps(meta, 1));
    return meta;
  }

  list(): { name: string; pid: number | null; state: string }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((n: string) => {
        const p = this.pid(n);
        // a group whose leader exited but whose members still run is RUNNING: stop still reaches it
        const state = p && (pidAlive(p) || groupAlive(p)) ? "RUNNING" : p ? "STOPPED" : "UNKNOWN";
        return { name: n, pid: p, state };
      });
  }

  async stop(name: string, graceMs = 5000, keepWorktree = false): Promise<Record<string, any>> {
    const r = await this.stopProcess(name, graceMs);
    if (r.result === "PID_REUSED") return r;
    const wt = this.meta(name).worktree;
    if (r.pid && groupAlive(r.pid)) {
      // SIGKILL could not end every member (for example one owned by another user): the
      // worktree may still be written to, so it is kept
      if (wt && wt.path) r.worktree = `worktree kept ${wt.path} (process group ${r.pid} still running)`;
      return r;
    }
    const note = this.cleanupWorktree(wt, keepWorktree);
    if (note) r.worktree = note;
    return r;
  }

  /**
   * SIGTERM to the process group, SIGKILL to the group after graceMs. "Stopped" means the whole
   * group is gone, not just its leader, so a child that ignores SIGTERM is killed too. A group
   * whose leader already exited but whose members still run is stopped the same way (its id
   * cannot be reused while any member exists).
   */
  private async stopProcess(name: string, graceMs: number): Promise<Record<string, any>> {
    const p = this.pid(name);
    if (!p) return { name, pid: p, result: "NOT_RUNNING" };
    const leader = pidAlive(p);
    if (!leader && !groupAlive(p)) return { name, pid: p, result: "NOT_RUNNING" };
    // ps still reports the start time of a zombie, so a reused pid is caught even when its new
    // owner has exited but not been reaped
    const recorded = this.meta(name).proc_start ?? null;
    const nowStart = procStart(p);
    if (recorded && nowStart && recorded !== nowStart) {
      // the worker exited and its pid now belongs to someone else: never signal it
      return { name, pid: p, result: "PID_REUSED" };
    }
    if (recorded && leader && !nowStart) {
      // the pid is alive but ps could not say whose it is: fail closed, signal nothing
      return { name, pid: p, result: "PID_REUSED" };
    }
    if (!signalGroup(p, "SIGTERM")) return { name, pid: p, result: "NOT_RUNNING" };
    if (await waitGroupGone(p, graceMs)) return { name, pid: p, result: "TERMINATED" };
    signalGroup(p, "SIGKILL");
    await waitGroupGone(p, 2000);
    return { name, pid: p, result: "KILLED" };
  }
}

/**
 * True while process group pgid has a live (non-zombie) member. kill(-pgid, 0) answers "none" for
 * sure (ESRCH); otherwise ps decides, because a group of only unreaped zombies still exists (and
 * macOS answers EPERM for it). If ps cannot be read, the group counts as alive (fail closed).
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (e: any) {
    if (e.code === "ESRCH") return false;
    if (e.code !== "EPERM") throw e;
  }
  const r = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return true;
  return r.stdout.split("\n").some((l) => {
    const [g, st] = l.trim().split(/\s+/);
    return Number(g) === pgid && Boolean(st) && !st.startsWith("Z");
  });
}

/**
 * Signal the group. False when no such group exists (ESRCH); members we may not signal (EPERM)
 * are left to the final groupAlive check.
 */
function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
  } catch (e: any) {
    if (e.code === "ESRCH") return false;
    if (e.code !== "EPERM") throw e;
  }
  return true;
}

/** Waits up to ms for every member of the group to exit. */
async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() >= end) return false;
    await sleep(100);
  }
}
