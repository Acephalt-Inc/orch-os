// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Args, CmdSpec } from "../args.js";
import type { IO } from "../cli.js";
import { ConfigError, configNumber, expand, load, orchHome } from "../config.js";
import { Lease } from "../lease.js";
import { Health } from "./health.js";
import { Messages } from "../messages.js";
import { sleep, validName } from "../util.js";
import { Scheduler, type Runner } from "./scheduler.js";
import { WakeWatch, workerSnapshot } from "./wake.js";

export type ServiceDeps = { runner?: Runner; userHome?: string; uid?: number; user?: string };
const runner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.error?.message ?? r.stderr ?? "" };
};
async function run(a: Args, io: IO): Promise<number> {
  const home = resolve(a.home ?? orchHome()), cfg = existsSync(join(home, "config.toml")) ? load(join(home, "config.toml")) : {};
  const s = cfg.service ?? {}, deps: ServiceDeps = a._service ?? {}, platform = a._platform ?? process.platform;
  for (const k of ["wake_watch", "health", "disk"]) if (s[k] !== undefined && typeof s[k] !== "boolean") throw new ConfigError(`[service] ${k} must be true or false`);
  const unavailable = (reason: string) => { io.out(JSON.stringify({ outcome: "UNAVAILABLE", reason, jobs: [] }) + "\n"); return 1; };
  if (s.disk && a._path[2] === "install") return unavailable("disk job is not implemented yet");
  const execute = deps.runner ?? runner;
  const path = (p: string) => expand(p.replace(/\$\{ORCH_HOME\}|\$ORCH_HOME\b/g, () => home));
  if (a._path[2] === "run") {
    const reader = s.reader ?? "lead";
    if (!validName(reader)) throw new ConfigError("[service] reader must be a valid agent name");
    const interval = configNumber(s.poll_seconds, 5, "[service] poll_seconds", 0.1) * 1000;
    const m = cfg.messages ?? {};
    const messages = new Messages(path(m.path ?? join(home, "messages.jsonl")), path(m.cursors ?? join(home, "cursors")));
    const workers = () => workerSnapshot(path(cfg.workers?.root ?? join(home, "workers")), platform, execute);
    if (a.job === "health") {
      const health = new Health(home, new Lease(path(cfg.lease?.path ?? join(home, "lease.json"))), messages, reader, workers,
        configNumber(s.deadman_seconds, 3600, "[service] deadman_seconds", 1));
      io.out(JSON.stringify(health.tick()) + "\n"); return 0;
    }
    const watch = new WakeWatch(home, messages, reader, workers);
    do { watch.tick(); if (a.once) return 0; await sleep(interval); } while (true);
  }
  const results = (["wake-watch", "health"] as const).map(job => {
    const scheduler = new Scheduler({ job, platform, home, userHome: deps.userHome ?? homedir(), node: process.execPath,
      cli: fileURLToPath(new URL("../cli.js", import.meta.url)), uid: deps.uid ?? process.getuid?.() ?? 0,
      user: deps.user ?? userInfo().username, prefix: s.label_prefix, runner: execute });
    const r = a._path[2] === "install" ? scheduler.install(a.dry_run, job === "health" ? s.health === true : s.wake_watch !== false)
      : a._path[2] === "uninstall" ? scheduler.uninstall(a.dry_run, true) : scheduler.status();
    return r;
  });
  const failed = results.find(r => ["UNAVAILABLE", "CONFLICT", "ERROR"].includes(r.outcome));
  const r = { outcome: failed?.outcome ?? (results.some(r => r.outcome === "DRY_RUN") ? "DRY_RUN" : results[0].outcome), jobs: results.flatMap(r => r.jobs),
    plans: results.flatMap(r => r.plan ? [r.plan] : []), reasons: results.flatMap(r => r.reason ? [r.reason] : []) };
  io.out(JSON.stringify(r, null, 2) + "\n");
  return failed ? 1 : 0;
}
export function serviceSpec(): CmdSpec<(a: Args, io: IO) => Promise<number>> {
  const dry = { dest: "dry_run", flags: ["--dry-run"], kind: "bool" as const, help: "print the plan without writing or changing jobs" };
  return { name: "service", help: "manage per-user scheduler jobs and watch wake events", sub: [
    ...["install", "status", "uninstall"].map((name) => ({ name, help: `${name} ORCH-owned jobs`, opts: [dry], run })),
    { name: "run", help: "run a scheduler job in the foreground", pos: [{ dest: "job", choices: ["wake-watch", "health"] }], opts: [
      { dest: "home", flags: ["--home"], kind: "str", help: "ORCH home passed by the scheduler" },
      { dest: "once", flags: ["--once"], kind: "bool", help: "process one poll and exit" },
    ], run },
  ] };
}
