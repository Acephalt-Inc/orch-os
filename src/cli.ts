#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** `orch`: command-line entry point for ORCH-os. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Args, type CmdSpec, HelpRequested, parse, UsageError } from "./args.js";
import * as C from "./config.js";
import * as D from "./detect.js";
import { Lease } from "./lease.js";
import * as LD from "./load.js";
import { LockLostError, LockTimeoutError } from "./lock.js";
import { Mailbox } from "./mailbox.js";
import { Mem, MemError } from "./mem.js";
import * as M from "./mergegate.js";
import { KINDS, MessageError, Messages, renderMessage, visible } from "./messages.js";
import { HANDBOOK, targetFile, writeHandbook, type Layout } from "./handbook.js";
import { dumps } from "./pyjson.js";
import { TaskError, Tasks } from "./tasks.js";
import { TomlError } from "./toml.js";
import { defaultSession, padEnd, sleep, which } from "./util.js";
import { WorkerError, Workers } from "./workers.js";

export const VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

export interface IO {
  out(s: string): void;
  err(s: string): void;
  stdin(): string;
}

const processIO: IO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: () => readFileSync(0, "utf8"),
};

type Run = (a: Args, io: IO) => number | Promise<number>;

// ---- wiring -----------------------------------------------------------------------------------

const num = C.configNumber;
const ConfigError = C.ConfigError;

function lease(cfg: Record<string, any>): Lease {
  const l = cfg.lease ?? {};
  return new Lease(C.expand(l.path ?? join(C.orchHome(), "lease.json")), num(l.default_seconds, 3600, "[lease] default_seconds", 1), num(l.min_seconds, 60, "[lease] min_seconds", 1));
}

function mailbox(cfg: Record<string, any>): Mailbox {
  const m = cfg.mailbox ?? {};
  return new Mailbox(C.expand(m.path ?? join(C.orchHome(), "mailbox.md")), m.sections ?? ["LEAD", "WORKER", "REVIEWER", "SYSTEM"]);
}

function loadPath(cfg: Record<string, any>): string {
  return C.expand((cfg.load ?? {}).state ?? join(C.orchHome(), "load.json"));
}

function workers(cfg: Record<string, any>): Workers {
  const w = cfg.workers ?? {};
  const wcfg = { ...cfg, workers: { ...w, worktree_root: w.worktree_root ?? join(C.orchHome(), "worktrees") } };
  return new Workers(wcfg, C.expand(w.root ?? join(C.orchHome(), "workers")), loadPath(cfg));
}

function messages(cfg: Record<string, any>): Messages {
  const m = cfg.messages ?? {};
  return new Messages(C.expand(m.path ?? join(C.orchHome(), "messages.jsonl")), C.expand(m.cursors ?? join(C.orchHome(), "cursors")));
}

function tasks(cfg: Record<string, any>): Tasks {
  const t = cfg.tasks ?? {};
  return new Tasks(C.expand(t.dir ?? join(C.orchHome(), "tasks")), num(t.default_seconds, 7200, "[tasks] default_seconds", 1), num(t.min_seconds, 60, "[tasks] min_seconds", 1));
}

function mem(cfg: Record<string, any>): Mem {
  const m = cfg.mem ?? {};
  return new Mem(C.expand(m.dir ?? join(C.orchHome(), "mem")), num(m.index_max_lines, 200, "[mem] index_max_lines", 1));
}

function handbookDir(cfg: Record<string, any>): string {
  return C.expand((cfg.handbook ?? {}).dir ?? join(C.orchHome(), "handbook"));
}

function session(a: Args): string {
  return a.session || process.env.ORCH_SESSION_ID || defaultSession();
}

/** Who "I" am for messages and task claims: --as, then $ORCH_AGENT, then the session id. */
function identity(a: Args): string {
  return a.as || process.env.ORCH_AGENT || process.env.ORCH_SESSION_ID || defaultSession();
}

function println(io: IO, s = ""): void {
  io.out(s + "\n");
}

function eprintln(io: IO, s: string): void {
  io.err(s + "\n");
}

// ---- commands ---------------------------------------------------------------------------------

function printAgents(io: IO, agents: D.Agent[], def?: string | null): void {
  if (!agents.length) {
    println(io, "agents: none of " + D.KNOWN.map((k) => k[0]).join(", ") + " found on PATH " +
      "(workers still run any command given after --)");
  }
  for (const a of agents) {
    const where = a.on_path ? "" : "  (not on PATH; absolute path used)";
    const mark = a.name === def ? "  <- default worker agent" : "";
    println(io, `agent ${padEnd(a.name, 7)} ${a.path}${where}${mark}`);
  }
}

const cmdInit: Run = (a, io) => {
  const home = C.orchHome();
  mkdirSync(home, { recursive: true });
  const p = C.configPath();
  const agents = D.installed();
  if (a.agent && !agents.some((x) => x.name === a.agent)) {
    eprintln(io, `init: agent '${a.agent}' not found; detected: ${agents.map((x) => x.name).join(", ") || "none"}`);
    return 2;
  }
  const def = a.agent || (agents.length ? agents[0].name : null);
  if (existsSync(p) && !a.force) {
    println(io, `config exists: ${p} (unchanged; --force rewrites it)`);
    printAgents(io, agents);
  } else {
    printAgents(io, agents, def);
    writeFileSync(p, C.renderDefault(home, agents, def));
    println(io, `wrote ${p}`);
  }
  const cfg = C.load();
  mkdirSync(join(home, "workers"), { recursive: true });
  const mb = mailbox(cfg);
  if (!existsSync(mb.path)) {
    mkdirSync(dirname(mb.path), { recursive: true });
    writeFileSync(mb.path, mb.skeleton());
    println(io, `wrote ${mb.path}`);
  }
  if (!a.no_handbook) {
    const dir = a.dir ? C.expand(a.dir) : handbookDir(cfg);
    const layout = (a.layout ?? "flat") as Layout;
    const rows = writeHandbook(dir, layout, a.force_handbook);
    const wrote = rows.filter((r) => r.action === "wrote");
    for (const r of wrote) println(io, `wrote ${r.file}`);
    if (wrote.length < rows.length) println(io, `kept ${rows.length - wrote.length} existing handbook file(s) in ${dir} (--force-handbook rewrites them)`);
    println(io, `boot: point each agent session at its role file, e.g. ${targetFile(dir, "lead-boot", layout)} (see docs/faq.md)`);
  }
  println(io, "next: orch doctor");
  return 0;
};

const cmdAgents: Run = (a, io) => {
  const rows = D.detect();
  const configured: Record<string, any> = C.loadOrDefault().agents ?? {};
  if (a.json) {
    for (const r of rows) r.configured = r.name in configured;
    println(io, dumps(rows, 1));
    return 0;
  }
  for (const r of rows) {
    const state = r.found ? (r.on_path ? "found" : "found (off PATH)") : "absent";
    const conf = r.name in configured ? "configured" : "-";
    println(io, `${padEnd(r.name, 7)} ${padEnd(state, 17)} ${padEnd(conf, 10)} ${r.path || r.label}`);
  }
  const known = new Set(rows.map((r) => r.name));
  for (const name of Object.keys(configured).filter((n) => !known.has(n)).sort()) {
    println(io, `${padEnd(name, 7)} ${padEnd("custom", 17)} ${padEnd("configured", 10)} ${(configured[name].command ?? []).join(" ")}`);
  }
  return 0;
};

/** Is `p` a writable directory, or creatable under the nearest existing ancestor? */
function dirUsable(p: string): boolean {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) {
      try {
        if (!statSync(cur).isDirectory()) return false;
        accessSync(cur, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

const cmdDoctor: Run = (_a, io) => {
  const rows: [string, string, string][] = [];
  const add = (ok: boolean, name: string, detail: string, optional = false) => {
    rows.push([ok ? "PASS" : optional ? "SKIP" : "FAIL", name, detail]);
  };
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20, "node>=20", process.versions.node);
  add(process.platform !== "win32", "posix (process groups)", process.platform);
  const p = C.configPath();
  let cfg: Record<string, any> | null = null;
  try {
    cfg = C.load(p);
    add(true, "config", p);
  } catch (e: any) {
    if (e && e.code === "ENOENT") add(false, "config", `${p} missing - run \`orch init\``);
    else add(false, "config", `${p} unreadable: ${e.message ?? e}`);
  }
  if (cfg !== null) {
    const home = C.orchHome();
    try {
      const t = join(home, `.doctor-${process.pid}`);
      closeSync(openSync(t, "wx"));
      unlinkSync(t);
      add(true, "state dir writable", home);
    } catch (e: any) {
      add(false, "state dir writable", String(e.message ?? e));
    }
    try {
      const [code, r] = lease(cfg).run("status");
      add(code === 0, "lease lockable", `${lease(cfg).path} (${r.status})`);
    } catch (e: any) {
      add(false, "lease lockable", String(e.message ?? e));
    }
    const mb = mailbox(cfg);
    let ok = false;
    try {
      accessSync(mb.path, constants.W_OK);
      ok = true;
    } catch { /* missing or read-only */ }
    add(ok, "mailbox", ok ? mb.path : `${mb.path} missing/unwritable - run \`orch init\``);
    add(mb.sections.length > 0, "mailbox sections", mb.sections.join(",") || "none configured");
    // a bad value in one table is one FAIL row, never an aborted report
    const check = (label: string, f: () => void) => {
      try {
        f();
      } catch (e: any) {
        add(false, label, String(e.message ?? e));
      }
    };
    check("messages", () => {
      const msg = messages(cfg!);
      num((cfg!.messages ?? {}).poll_seconds, 5, "[messages] poll_seconds");
      add(dirUsable(dirname(msg.path)) && dirUsable(msg.cursorDir), "messages", msg.path);
    });
    check("task registry", () => {
      const tk = tasks(cfg!);
      add(dirUsable(tk.dir), "task registry", tk.dir);
    });
    check("mem", () => {
      const mm = mem(cfg!);
      add(dirUsable(mm.dir), "mem", `${mm.dir} (${mm.indexLines()}/${mm.indexMaxLines} index lines)`);
    });
    check("worker limits", () => {
      const w = cfg!.workers ?? {};
      num(w.timeout_minutes, 60, "[workers] timeout_minutes");
      num(w.nice, 5, "[workers] nice", -20);
    });
    const pb = handbookDir(cfg);
    const have = HANDBOOK.filter((n) => existsSync(targetFile(pb, n, "flat")) || existsSync(targetFile(pb, n, "skills")));
    add(have.length === HANDBOOK.length, "handbook", have.length === HANDBOOK.length ? pb : `${have.length}/${HANDBOOK.length} files in ${pb} - run \`orch init\``, true);
    const git = which("git");
    add(git !== null, "git", git ?? "not on PATH");
    const gh = which("gh");
    add(gh !== null, "gh (merge-gate live mode)", gh ?? "absent - fixtures still work", true);
    const repo = (cfg.merge ?? {}).repo ?? "";
    add(Boolean(repo), "merge repo", repo || "unset - pass --repo or use --fixture", true);
    const wcmd = ((cfg.workers ?? {}).command ?? [""])[0] ?? "";
    add(Boolean(wcmd) && which(wcmd) !== null, "worker command",
      wcmd ? which(wcmd) ?? `'${wcmd}' not on PATH - pass a command after --` : "none configured - use --agent or pass a command after --", true);
    const to = which("timeout") ?? which("gtimeout");
    add(to !== null, "timeout (worker time limit)", to ?? "absent - workers run without a time limit", true);
    const found = D.installed().map((x) => x.name);
    add(found.length > 0, "agent CLIs", found.join(", ") || "none found (install one, then `orch init --force`)", true);
    for (const [name, ag] of Object.entries<any>(cfg.agents ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))) {
      const b = (ag.command ?? [""])[0] ?? "";
      add(Boolean(b) && which(b) !== null, `agent ${name}`, b || "empty command", true);
    }
    const tier = LD.readState(loadPath(cfg)).tier;
    add(true, "load state", tier || "no sample yet (run `orch load`)");
  }
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [s, n, d] of rows) println(io, `${padEnd(s, 4)}  ${padEnd(n, w)}  ${d}`);
  const fails = rows.filter((r) => r[0] === "FAIL").length;
  println(io, `doctor: ${fails ? "FAIL" : "PASS"} (${fails} required check(s) failed)`);
  return fails ? 1 : 0;
};

const cmdConfig: Run = (_a, io) => {
  const cfg = C.loadOrDefault();
  println(io, `# resolved from ${C.configPath()}` + (existsSync(C.configPath()) ? "" : " (absent: defaults)"));
  println(io, dumps(cfg, 2));
  return 0;
};

const cmdLease: Run = (a, io) => {
  const cfg = C.loadOrDefault();
  const sess = a.action === "status" ? null : session(a);
  const [code, r] = lease(cfg).run(a.action, sess, { leaseSeconds: a.seconds, force: a.force, expectedEpoch: a.expected_epoch });
  if (a.json) println(io, dumps(r));
  else {
    const st = r.state ?? {};
    const left = st.lease_expires_at ? st.lease_expires_at - r.now : 0;
    println(io, `lease ${r.status} holder=${st.session_id ?? r.holder ?? "None"} epoch=${st.epoch ?? "None"} expires_in=${Math.max(0, Math.trunc(left))}s`);
  }
  return code;
};

function safeStdin(io: IO): string {
  try {
    return io.stdin();
  } catch {
    return "";
  }
}

function body(a: Args, io: IO, required = true): string {
  if (a.message !== null && a.message !== undefined) return a.message;
  return required ? io.stdin() : "";
}

const cmdMailbox: Run = (a, io) => {
  const mb = mailbox(C.loadOrDefault());
  if (a._path[2] === "post") {
    const text = body(a, io);
    let eid: string;
    try {
      eid = mb.post(a.section, text, a.author);
    } catch (e: any) {
      if (e instanceof RangeError) {
        eprintln(io, `mailbox: ${e.message}`);
        return 2;
      }
      throw e;
    }
    println(io, `posted ${a.section.toUpperCase()} entry ${eid}`);
    return 0;
  }
  for (const e of mb.read(a.n ?? 10, a.section)) {
    const who = e.section + (e.author ? `/${e.author}` : "");
    println(io, `--- ${visible(e.ts)} (${who})\n${visible(e.body)}`);
  }
  return 0;
};

/** --reviews, else [review] source, else "github". A bad config value is a ConfigError (exit 2). */
function reviewSource(cfg: Record<string, any>, a: Args): M.ReviewSource {
  if (a.reviews) return a.reviews;
  const v = (cfg.review ?? {}).source ?? "github";
  if (!(M.REVIEW_SOURCES as unknown[]).includes(v)) throw new ConfigError(`[review] source must be "github" or "comments" (got ${JSON.stringify(v)})`);
  return v;
}

/**
 * comments mode: the task's author agent(s) from the task store: the recorded holder, and the
 * holder before it if the task changed hands. Never the GitHub login.
 */
function taskAuthors(cfg: Record<string, any>, id: string): string[] {
  const [, r] = tasks(cfg).status(id);
  const st = r.state ?? {};
  return [st.session_id, st.previous_owner].filter((x): x is string => typeof x === "string" && x !== "");
}

const cmdMergeGate: Run = (a, io) => {
  const cfg = C.loadOrDefault();
  const mc = cfg.merge ?? {};
  const source = reviewSource(cfg, a);
  let authors: string[] = [];
  if (source === "comments") {
    if (!a.task) {
      println(io, `#${a.pr} => BLOCKED (comments mode needs --task ID: the task whose holder authored this PR)`);
      return 1;
    }
    try {
      authors = taskAuthors(cfg, a.task);
    } catch (e: any) {
      println(io, `#${a.pr} => BLOCKED (${e.message ?? e})`);
      return 1;
    }
    if (!authors.length) {
      println(io, `#${a.pr} => BLOCKED (task '${a.task}' has no recorded holder; the author claims it with \`orch task claim\`)`);
      return 1;
    }
  }
  let info: unknown;
  try {
    info = a.fixture ? M.loadFixture(a.fixture) : M.fetchLive(a.pr, a.repo || mc.repo || "", source);
  } catch (e: any) {
    println(io, `#${a.pr} => BLOCKED (${e.message ?? e})`);
    return 1;
  }
  const need = a.approvals ?? Number(mc.required_approvals ?? 1);
  const label = a.label ?? mc.required_label ?? "";
  let r: Record<string, any>;
  try {
    r = source === "comments"
      ? M.evaluate(info, { requiredApprovals: need, requiredLabel: label, head: a.head, reviewSource: source, authorAgents: authors })
      : M.evaluate(info, { requiredApprovals: need, requiredLabel: label, head: a.head });
  } catch (e: any) {
    // malformed PR data fails closed
    println(io, `#${a.pr} => BLOCKED (unreadable PR data: ${e.message ?? e})`);
    return 1;
  }
  println(io, a.json ? dumps(r) : M.render(a.pr, r));
  return r.ok ? 0 : 1;
};

const VERDICT_OF: Record<string, M.Verdict> = { approve: "APPROVE", changes: "CHANGES", reject: "REJECT" };

const cmdReview: Run = (a, io) => {
  const verdict = VERDICT_OF[a._path[2]];
  const agent = identity(a);
  const repo = a.repo || (C.loadOrDefault().merge ?? {}).repo || "";
  let head: string = (a.head ?? "").toLowerCase();
  let line: string;
  try {
    if (!head) head = M.fetchHead(a.pr, repo);
    line = M.reviewLine(verdict, head, agent);
  } catch (e: any) {
    eprintln(io, `review: ${e.message ?? e}`);
    return 2;
  }
  const text = line + (a.message ? `\n\n${a.message}` : "");
  if (a.dry_run) {
    println(io, text);
    return 0;
  }
  try {
    M.postComment(a.pr, repo, text);
  } catch (e: any) {
    eprintln(io, `review: ${e.message ?? e}`);
    return 1;
  }
  println(io, `posted on #${a.pr}: ${line}`);
  return 0;
};

const cmdWorker: Run = async (a, io) => {
  const w = workers(C.loadOrDefault());
  try {
    const action = a._path[2];
    if (action === "start") {
      const m = w.start(a.name, {
        command: a.cmd?.length ? a.cmd : null, task: a.task, workdir: a.workdir, minutes: a.minutes,
        force: a.force, agent: a.agent, worktree: a.worktree, branch: a.branch, base: a.base,
      });
      println(io, `worker ${m.name} started pid=${m.pid} load=${m.load_tier} dir=${w.dir(m.name)}`);
      if (m.worktree) println(io, `worktree ${m.worktree.path} branch=${m.worktree.branch} (${m.worktree.created ? "created" : "attached"})`);
    } else if (action === "list") {
      const rows = w.list();
      if (!rows.length) println(io, "no workers");
      for (const r of rows) println(io, `${padEnd(r.name, 20)} ${padEnd(r.state, 8)} pid=${r.pid ?? "None"}`);
    } else {
      const r = await w.stop(a.name, 5000, a.keep_worktree);
      println(io, `worker ${r.name} ${r.result} pid=${r.pid ?? "None"}`);
      if (r.worktree) println(io, r.worktree);
    }
  } catch (e: any) {
    if (e instanceof WorkerError || (e && typeof e.code === "string")) {
      eprintln(io, `worker: ${e.message}`);
      return 2;
    }
    throw e;
  }
  return 0;
};

const cmdLoad: Run = (a, io) => {
  const cfg = C.loadOrDefault();
  const path = loadPath(cfg);
  let st: Record<string, any>;
  try {
    st = a.read ? LD.readState(path) : LD.step(cfg, path);
  } catch (e: any) {
    if (e instanceof SyntaxError) throw new ConfigError(`[load] renice_pattern is not a valid regular expression (${e.message})`);
    throw e;
  }
  if (a.json) {
    const { history: _h, ...rest } = st;
    println(io, dumps(rest));
  } else {
    const f = (k: string, unit = "") => (st[k] === undefined || st[k] === null ? "n/a" : `${st[k]}${unit}`);
    println(io, `load tier=${st.tier ?? "NORMAL"} load_ratio=${f("load_ratio")} swap=${f("swap_pct", "%")} ` +
      `temp=${f("temp_c", "C")} reniced=${st.reniced ?? 0}`);
  }
  return 0;
};

const cmdMsg: Run = async (a, io) => {
  const cfg = C.loadOrDefault();
  const box = messages(cfg);
  const action = a._path[2];
  try {
    if (action === "send") {
      const m = box.send(a.from || identity(a), a.to, a.kind, body(a, io), a.reply_to);
      if (a.json) println(io, dumps(m));
      else println(io, `sent ${m.kind} ${m.id} seq=${m.seq} to=${m.to}`);
      return 0;
    }
    const me = identity(a);
    if (action === "read") {
      let list = a.all ? box.inbox(me) : box.pending(me);
      if (a.n) list = list.slice(-a.n); // -n 0 keeps everything, like mailbox read
      for (const m of list) println(io, a.json ? dumps(m) : renderMessage(m));
      if (a.ack && list.length) box.ack(me, list.map((m) => m.id));
      if (!list.length && !a.json) println(io, `no ${a.all ? "" : "pending "}messages for ${me}`);
      return 0;
    }
    if (action === "ack") {
      const ids: string[] = a.ids ?? [];
      if (!a.all && !ids.length) {
        eprintln(io, "msg: give message ids, or --all");
        return 2;
      }
      const fresh = box.ack(me, a.all ? "all" : ids);
      println(io, `acked ${fresh.length} message(s) for ${me}; ${box.pending(me).length} pending`);
      return 0;
    }
    // watch
    const interval = Math.max(0.05, a.interval ?? num((cfg.messages ?? {}).poll_seconds, 5, "[messages] poll_seconds"));
    const deadline = a.timeout !== null && a.timeout !== undefined ? Date.now() + a.timeout * 1000 : Infinity;
    const shown = new Set<string>();
    let count = 0;
    for (;;) {
      for (const m of box.pending(me)) {
        if (shown.has(m.id)) continue;
        shown.add(m.id);
        println(io, a.json ? dumps(m) : renderMessage(m));
        if (a.ack) box.ack(me, [m.id]);
        count++;
        if (a.count && count >= a.count) return 0;
      }
      const left = deadline - Date.now();
      if (left <= 0) return 0;
      await sleep(Math.min(interval * 1000, left));
    }
  } catch (e: any) {
    if (e instanceof MessageError) {
      eprintln(io, `msg: ${e.message}`);
      return 2;
    }
    throw e;
  }
};

const cmdTask: Run = (a, io) => {
  const t = tasks(C.loadOrDefault());
  const action = a._path[2];
  try {
    if (action === "list") {
      const rows = t.list();
      if (a.json) println(io, dumps(rows));
      else if (!rows.length) println(io, "no tasks");
      else for (const r of rows) println(io, `${padEnd(r.id, 24)} ${padEnd(r.status, 8)} holder=${r.holder ?? "None"} epoch=${r.epoch ?? "None"} expires_in=${r.expires_in}s`);
      return 0;
    }
    let code: number;
    let r: Record<string, any>;
    if (action === "status") [code, r] = t.status(a.id);
    else {
      const me = identity(a);
      if (action === "claim") [code, r] = t.claim(a.id, me, { seconds: a.seconds });
      else if (action === "renew") [code, r] = t.renew(a.id, me, { seconds: a.seconds, expectedEpoch: a.expected_epoch });
      else [code, r] = t.release(a.id, me, { expectedEpoch: a.expected_epoch });
    }
    if (a.json) println(io, dumps(r));
    else {
      const st = r.state ?? {};
      const left = st.lease_expires_at ? st.lease_expires_at - r.now : 0;
      println(io, `task ${r.task ?? a.id} ${r.status} holder=${st.session_id ?? r.holder ?? "None"} epoch=${st.epoch ?? "None"} expires_in=${Math.max(0, Math.trunc(left))}s`);
    }
    return code;
  } catch (e: any) {
    if (e instanceof TaskError) {
      eprintln(io, `task: ${e.message}`);
      return 2;
    }
    throw e;
  }
};

const cmdMem: Run = (a, io) => {
  const m = mem(C.loadOrDefault());
  const action = a._path[2];
  try {
    if (action === "add") {
      const text = a.message ?? (process.stdin.isTTY ? "" : safeStdin(io));
      const r = m.add(a.name, a.description, text, a.type ?? "note");
      println(io, `added ${r.entry.name} (${r.entry.type}) ${r.entry.file}; index ${r.indexLines}/${r.cap} lines`);
      if (r.warning) eprintln(io, `mem: warning: ${r.warning}`);
      return 0;
    }
    if (action === "retire") {
      const e = m.retire(a.name, a.superseded_by, a.reason);
      println(io, `retired ${e.name}` + (e.superseded_by ? ` (superseded by ${e.superseded_by})` : "") + `; file kept: ${e.file}`);
      return 0;
    }
    const hits = m.search(a.terms ?? [], { type: a.type, all: a.all });
    if (a.json) println(io, dumps(hits.map(({ file, ...rest }) => ({ ...rest, file }))));
    else {
      for (const e of hits) {
        const st = e.status === "retired" ? `  [retired${e.superseded_by ? ` -> ${e.superseded_by}` : ""}]` : "";
        println(io, `${padEnd(e.name, 24)} ${padEnd(e.type, 10)} ${e.description}${st}`);
      }
    }
    return hits.length ? 0 : 1;
  } catch (e: any) {
    if (e instanceof MemError) {
      eprintln(io, `mem: ${e.message}`);
      return 2;
    }
    throw e;
  }
};

// ---- the command tree -------------------------------------------------------------------------

const opt = (dest: string, flags: string[], kind: "bool" | "str" | "int" | "float", help: string, extra: Partial<{ metavar: string; choices: string[] }> = {}) =>
  ({ dest, flags, kind, help, ...extra });
const JSON_OPT = opt("json", ["--json"], "bool", "machine-readable output");
const AS_OPT = opt("as", ["--as"], "str", "my name (default $ORCH_AGENT, then $ORCH_SESSION_ID, then user@host)", { metavar: "NAME" });

export function buildTree(): CmdSpec<Run> {
  return {
    name: "orch",
    help: "ORCH-os: run several CLI coding agents as one team (lease, mailbox, messages, task claims, merge gate, workers, load governor, mem).",
    sub: [
      {
        name: "init", help: "detect agent CLIs; write config.toml, the mailbox, and the role boot files + handbook", run: cmdInit,
        opts: [
          opt("force", ["--force"], "bool", "rewrite config.toml from defaults + fresh detection"),
          opt("agent", ["--agent"], "str", "default worker agent (default: first detected)"),
          opt("dir", ["--dir"], "str", "where to write the handbook (default [handbook] dir)"),
          opt("layout", ["--layout"], "str", "flat (NAME.md) or skills (NAME/SKILL.md)", { choices: ["flat", "skills"] }),
          opt("force_handbook", ["--force-handbook"], "bool", "overwrite handbook files you may have edited"),
          opt("no_handbook", ["--no-handbook"], "bool", "do not write the handbook"),
        ],
      },
      { name: "agents", help: "list known agent CLIs: installed? configured?", run: cmdAgents, opts: [JSON_OPT] },
      { name: "doctor", help: "PASS/FAIL per prerequisite; exit 1 on any FAIL", run: cmdDoctor },
      { name: "config", help: "print the resolved configuration", run: cmdConfig },
      {
        name: "lease", help: "single-holder role lease", run: cmdLease,
        pos: [{ dest: "action", choices: ["status", "acquire", "renew", "release"] }],
        opts: [
          opt("session", ["--session"], "str", "session id (default $ORCH_SESSION_ID or user@host)"),
          opt("seconds", ["--seconds"], "int", "lease duration (default [lease] default_seconds)"),
          opt("expected_epoch", ["--expected-epoch"], "int", "renew/release only if the epoch still matches"),
          opt("force", ["--force"], "bool", "take over an unexpired lease held by someone else"),
          JSON_OPT,
        ],
      },
      {
        name: "mailbox", help: "shared mailbox",
        sub: [
          {
            name: "post", help: "post an entry (body from -m or stdin)", run: cmdMailbox, pos: [{ dest: "section" }],
            opts: [opt("message", ["-m", "--message"], "str", "entry text"), opt("author", ["--author"], "str", "author name")],
          },
          {
            name: "read", help: "newest entries, oldest first", run: cmdMailbox,
            opts: [opt("n", ["-n"], "int", "how many (default 10)"), opt("section", ["--section"], "str", "only this section")],
          },
        ],
      },
      {
        name: "msg", help: "addressed agent-to-agent messages with per-reader acks",
        sub: [
          {
            name: "send", help: `send a message: KIND is one of ${KINDS.join(", ")}`, run: cmdMsg,
            usage: "orch msg send KIND --to NAME|* [-m TEXT] [--reply-to ID] [--from NAME] [--json]",
            pos: [{ dest: "kind" }],
            opts: [
              opt("to", ["--to"], "str", "recipient name, or * for everyone", { metavar: "NAME" }),
              opt("message", ["-m", "--message"], "str", "message text (default: stdin)"),
              opt("reply_to", ["--reply-to"], "str", "id of the message this answers (required for ANSWER)", { metavar: "ID" }),
              opt("from", ["--from"], "str", "sender (default: my name, see --as)", { metavar: "NAME" }),
              AS_OPT, JSON_OPT,
            ],
          },
          {
            name: "read", help: "print my pending messages (oldest first); nothing is acked unless --ack", run: cmdMsg,
            opts: [AS_OPT, opt("all", ["--all"], "bool", "include acked messages"), opt("ack", ["--ack"], "bool", "ack what was printed"),
              opt("n", ["-n"], "int", "only the newest N"), JSON_OPT],
          },
          {
            name: "ack", help: "acknowledge messages by id (or --all pending)", run: cmdMsg,
            pos: [{ dest: "ids", variadic: true }], opts: [AS_OPT, opt("all", ["--all"], "bool", "ack every pending message")],
          },
          {
            name: "watch", help: "poll and print new messages addressed to me", run: cmdMsg,
            opts: [AS_OPT, opt("interval", ["--interval"], "float", "seconds between polls (default [messages] poll_seconds)"),
              opt("timeout", ["--timeout"], "float", "stop after this many seconds (default: run until interrupted)"),
              opt("count", ["--count"], "int", "stop after this many messages"),
              opt("ack", ["--ack"], "bool", "ack each message as it is printed"), JSON_OPT],
          },
        ],
      },
      {
        name: "task", help: "exclusive task claims with epoch fencing",
        sub: [
          { name: "claim", help: "claim a task (or extend your own claim)", run: cmdTask, pos: [{ dest: "id" }],
            opts: [AS_OPT, opt("seconds", ["--seconds"], "int", "claim duration (default [tasks] default_seconds)"), JSON_OPT] },
          { name: "renew", help: "extend your claim; with --expected-epoch, only if the epoch still matches", run: cmdTask, pos: [{ dest: "id" }],
            opts: [AS_OPT, opt("seconds", ["--seconds"], "int", "claim duration"), opt("expected_epoch", ["--expected-epoch"], "int", "fencing token from your claim"), JSON_OPT] },
          { name: "release", help: "release your claim", run: cmdTask, pos: [{ dest: "id" }],
            opts: [AS_OPT, opt("expected_epoch", ["--expected-epoch"], "int", "fencing token from your claim"), JSON_OPT] },
          { name: "status", help: "show one task", run: cmdTask, pos: [{ dest: "id" }], opts: [JSON_OPT] },
          { name: "list", help: "every task with holder, epoch and expiry", run: cmdTask, opts: [JSON_OPT] },
        ],
      },
      {
        name: "merge-gate", help: "may this PR merge? CI + approvals at the live head", run: cmdMergeGate,
        pos: [{ dest: "pr" }],
        opts: [
          opt("repo", ["--repo"], "str", "owner/name"),
          opt("head", ["--head"], "str", "expected head commit: BLOCKED (head moved) if the PR is elsewhere"),
          opt("approvals", ["--approvals"], "int", "required approvals (default [merge] required_approvals)"),
          opt("label", ["--label"], "str", "required label (default [merge] required_label; '' = none)"),
          opt("fixture", ["--fixture"], "str", "offline: a bundled fixture (" + M.fixtureNames().join(", ") + ") or a path to `gh pr view --json` output"),
          opt("reviews", ["--reviews"], "str", "where approvals come from (default [review] source, else github)", { choices: M.REVIEW_SOURCES }),
          opt("task", ["--task"], "str", "comments mode: the task id whose holder authored the PR", { metavar: "ID" }),
          JSON_OPT,
        ],
      },
      {
        name: "review", help: "post a review comment (ORCH-REVIEW line) as a PR comment, for merge-gate --reviews comments",
        sub: (["approve", "changes", "reject"] as const).map((v) => ({
          name: v, help: `post 'ORCH-REVIEW ${VERDICT_OF[v]} <head sha> by <me>' on the PR`, run: cmdReview,
          usage: `orch review ${v} PR [--as NAME] [--head SHA] [--repo OWNER/NAME] [-m TEXT] [--dry-run]`,
          pos: [{ dest: "pr" }],
          opts: [
            AS_OPT,
            opt("head", ["--head"], "str", "the full 40-character sha you reviewed (default: the PR's live head, via gh)"),
            opt("repo", ["--repo"], "str", "owner/name (default [merge] repo)"),
            opt("message", ["-m", "--message"], "str", "text after the review comment line"),
            opt("dry_run", ["--dry-run"], "bool", "print the comment instead of posting it"),
          ],
        })),
      },
      {
        name: "worker", help: "detached agent workers",
        sub: [
          {
            name: "start", help: "start a worker: orch worker start NAME [--task F] [-- CMD ...]", run: cmdWorker,
            usage: "orch worker start NAME [--task F] [--workdir D] [--minutes M] [--agent A] [--worktree [--branch B] [--base REF]] [--force] [-- CMD ...]",
            pos: [{ dest: "name" }],
            opts: [
              opt("task", ["--task"], "str", "file fed to the worker on stdin"),
              opt("workdir", ["--workdir"], "str", "working directory (with --worktree: the repository)"),
              opt("minutes", ["--minutes"], "float", "time limit (0 = none; default [workers] timeout_minutes)"),
              opt("agent", ["--agent"], "str", "use the [agents.<name>] command"),
              opt("worktree", ["--worktree"], "bool", "run in its own git worktree under [workers] worktree_root"),
              opt("branch", ["--branch"], "str", "worktree branch (default <worktree_branch_prefix>NAME)"),
              opt("base", ["--base"], "str", "start point for a new branch (default HEAD)"),
              opt("force", ["--force"], "bool", "start even when the load tier blocks it"),
            ],
          },
          { name: "list", help: "every worker with RUNNING / STOPPED / UNKNOWN", run: cmdWorker },
          { name: "stop", help: "stop the worker's process group; remove its worktree if orch created it and it is clean", run: cmdWorker,
            pos: [{ dest: "name" }], opts: [opt("keep_worktree", ["--keep-worktree"], "bool", "never remove the worktree")] },
        ],
      },
      {
        name: "load", help: "take one load sample and print the tier", run: cmdLoad,
        opts: [opt("read", ["--read"], "bool", "print the last state without sampling"), JSON_OPT],
      },
      {
        name: "mem", help: "long-lived notes: one file per entry, a capped index, retire instead of delete",
        sub: [
          { name: "add", help: "add an entry (body from -m or stdin)", run: cmdMem, pos: [{ dest: "name" }],
            usage: "orch mem add NAME --description TEXT [--type TYPE] [-m BODY]",
            opts: [opt("description", ["--description", "-d"], "str", "one line, shown in the index"),
              opt("type", ["--type", "-t"], "str", "rule, lesson, fact, reference, note (default) or any word"),
              opt("message", ["-m", "--message"], "str", "body text")] },
          { name: "search", help: "entries matching every term (exit 1 when none)", run: cmdMem, pos: [{ dest: "terms", variadic: true }],
            opts: [opt("type", ["--type", "-t"], "str", "only this type"), opt("all", ["--all"], "bool", "include retired entries"), JSON_OPT] },
          { name: "retire", help: "mark an entry retired (the file is kept) and record what supersedes it", run: cmdMem, pos: [{ dest: "name" }],
            opts: [opt("superseded_by", ["--superseded-by"], "str", "the entry that replaces it", { metavar: "NAME" }),
              opt("reason", ["--reason"], "str", "one line: why it no longer holds")] },
        ],
      },
    ],
  };
}

/** Run the CLI. Returns the exit code; never calls process.exit itself. */
export async function main(argv: string[] = process.argv.slice(2), io: IO = processIO): Promise<number> {
  argv = [...argv];
  let rest: string[] = [];
  // everything after the first `--` is a worker command, never parsed as options
  if (argv.includes("--") && argv[0] === "worker" && argv[1] === "start") {
    const i = argv.indexOf("--");
    rest = argv.slice(i + 1);
    argv = argv.slice(0, i);
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    println(io, `orch ${VERSION}`);
    return 0;
  }
  const tree = buildTree();
  let parsed;
  try {
    parsed = parse(tree, argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      println(io, e.text);
      return 0;
    }
    if (e instanceof UsageError) {
      eprintln(io, `${e.usage}\norch: error: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const { args, cmd } = parsed;
  args.cmd = rest;
  if (cmd.name === "add" && args._path[1] === "mem" && (args.description === null || args.description === undefined)) {
    eprintln(io, `usage: ${cmd.usage}\norch: error: the following arguments are required: --description`);
    return 2;
  }
  if (cmd.name === "send" && args._path[1] === "msg" && !args.to) {
    eprintln(io, `usage: ${cmd.usage}\norch: error: the following arguments are required: --to`);
    return 2;
  }
  try {
    return await cmd.run!(args, io);
  } catch (e: any) {
    if (e instanceof TomlError) {
      eprintln(io, `orch: ${C.configPath()} is not valid TOML (${e.message}); fix it or run \`orch init --force\``);
      return 2;
    }
    if (e instanceof ConfigError) {
      eprintln(io, `orch: ${C.configPath()}: ${e.message}`);
      return 2;
    }
    if (e instanceof LockTimeoutError) {
      eprintln(io, `orch: ${e.message}`);
      return 2;
    }
    if (e instanceof LockLostError) {
      eprintln(io, `orch: ${e.message}; the result was not verified`);
      return 5;
    }
    throw e;
  }
}

function isEntry(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    // like v1.1's uncaught traceback: message on stderr, exit 1
    process.stderr.write(`orch: error: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
