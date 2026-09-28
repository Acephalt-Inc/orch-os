#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** `orch`: command-line entry point for ORCH-os. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync, accessSync, constants } from "node:fs";
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
import * as P from "./profile.js";
import { dumps } from "./pyjson.js";
import { TaskError, Tasks } from "./tasks.js";
import { parseToml, TomlError } from "./toml.js";
import { atomicWrite, defaultSession, isPlainObject, padEnd, sleep, sleepSync, which } from "./util.js";
import { WorkerError, Workers } from "./workers.js";

export const VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

export interface IO {
  out(s: string): void;
  err(s: string): void;
  stdin(): string;
  /** Is stdin a terminal? Absent = no (nothing is asked). */
  isTTY?(): boolean;
  /** Print a question and read one answer line; null at end of input. */
  ask?(q: string): string | null;
}

/** One line from fd 0, without its newline; null at end of input. */
function readLineSync(): string | null {
  const bytes: number[] = [];
  const b = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, b, 0, 1, null);
    } catch (e: any) {
      if (e && e.code === "EAGAIN") {
        sleepSync(20);
        continue;
      }
      if (!(e && e.code === "EOF")) throw e;
    }
    if (n === 0) return bytes.length ? Buffer.from(bytes).toString("utf8") : null;
    if (b[0] === 10) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(b[0]);
  }
}

const processIO: IO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: () => readFileSync(0, "utf8"),
  isTTY: () => Boolean(process.stdin.isTTY),
  ask: (q) => {
    process.stdout.write(q);
    return readLineSync();
  },
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

/** Ask until an answer is in `map` (3 tries); null = no answer. */
function askChoice(io: IO, q: string, map: Record<string, string>): string | null {
  for (let i = 0; i < 3; i++) {
    const ans = io.ask!(q);
    if (ans === null) return null;
    const k = ans.trim().toLowerCase();
    if (Object.hasOwn(map, k)) return map[k];
    println(io, `  answer one of: ${Object.keys(map).filter((x) => x).join(", ")}`);
  }
  return null;
}

/** The two `orch init` questions. Detected agent CLIs pre-fill the account vendors. */
function askProfile(io: IO, found: string[]): Record<string, any> | null {
  const compute = askChoice(io, "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs? [1/2/3, default 1] ",
    { "": "one", "1": "one", one: "one", "2": "same-vendor", "same-vendor": "same-vendor", "3": "multi-vendor", "multi-vendor": "multi-vendor" });
  if (!compute) return null;
  const people = askChoice(io, "Solo, or with teammates? [solo/team, default solo] ", { "": "solo", solo: "solo", team: "team", teammates: "team" });
  if (!people) return null;
  return P.initialProfile(compute as P.Compute, people as P.People, found);
}

const cmdInit: Run = (a, io) => {
  if (Boolean(a.compute) !== Boolean(a.people)) {
    eprintln(io, "init: --compute and --people go together: give both, or neither");
    return 2;
  }
  if (a.no_profile && a.compute) {
    eprintln(io, "init: --no-profile cannot be combined with --compute/--people");
    return 2;
  }
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
    if (a.compute) {
      eprintln(io, `init: ${p} exists and is not rewritten without --force; set the profile with \`orch profile update --compute ${a.compute} --people ${a.people}\``);
      return 2;
    }
    println(io, `config exists: ${p} (unchanged; --force rewrites it)`);
    printAgents(io, agents);
  } else {
    // --force keeps an existing [profile] as it was, unless --compute/--people replace it
    let kept = "";
    if (existsSync(p) && !a.compute) {
      const old = readFileSync(p, "utf8");
      try {
        kept = P.profileBlock(old);
      } catch (e) {
        if (!(e instanceof TomlError)) throw e;
        if (/^\s*\[\s*profile\b/m.test(old)) {
          eprintln(io, `init: ${p} is not valid TOML (${e.message}) and has a [profile] table; fix it, or remove the table, before --force`);
          return 2;
        }
      }
    }
    printAgents(io, agents, def);
    const found = agents.map((x) => x.name);
    const fresh = kept ? null : a.compute ? P.initialProfile(a.compute, a.people, found)
      : !a.no_profile && io.isTTY?.() && io.ask ? askProfile(io, found) : null;
    let text = C.renderDefault(home, agents, def);
    if (kept) text = P.withProfileBlock(text, kept);
    else if (fresh) {
      text = P.writeProfileText(text, fresh);
      P.readProfile(parseToml(text)); // a bad value is a ConfigError (exit 2) before anything is written
    }
    writeFileSync(p, text);
    println(io, `wrote ${p}`);
    if (kept) println(io, "kept the existing [profile] tables");
    else if (fresh) println(io, `profile: ${P.cellLabel(P.readProfile(parseToml(text))!)} (\`orch profile show\`; add agents with \`orch profile update --agent NAME=ACCOUNT\`)`);
    else if (io.isTTY?.() && io.ask && !a.no_profile) println(io, "no profile written (`orch profile update --compute ... --people ...` adds one later)");
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
    // profile rows only when a [profile] table exists: without one, doctor prints what it always did
    let prof: P.Profile | null = null;
    try {
      prof = P.readProfile(cfg);
    } catch (e: any) {
      add(false, "profile", String(e.message ?? e));
    }
    if (prof) for (const [ok, name, detail] of P.capabilityRows(prof, profileEnv(cfg))) add(ok, name, detail, true);
  }
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [s, n, d] of rows) println(io, `${padEnd(s, 4)}  ${padEnd(n, w)}  ${d}`);
  const fails = rows.filter((r) => r[0] === "FAIL").length;
  println(io, `doctor: ${fails ? "FAIL" : "PASS"} (${fails} required check(s) failed)`);
  return fails ? 1 : 0;
};

function profileEnv(cfg: Record<string, any>): P.Env {
  return {
    found: D.installed().map((x) => x.name), configured: Object.keys(cfg.agents ?? {}),
    gh: which("gh") !== null, repo: (cfg.merge ?? {}).repo ?? "",
  };
}

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

/** comments mode: the task's author agents from the task store: every agent that has held it. Never the GitHub login. */
function taskAuthors(cfg: Record<string, any>, id: string): string[] {
  return tasks(cfg).holders(id);
}

const cmdMergeGate: Run = (a, io) => {
  const cfg = C.loadOrDefault();
  const mc = cfg.merge ?? {};
  const source = reviewSource(cfg, a);
  const prof = P.readProfile(cfg);
  if (!prof && (a.tier || a.auto)) {
    eprintln(io, `merge-gate: ${a.tier ? "--tier" : "--auto"} needs a [profile] table in config.toml, and none is set (see \`orch profile update\`)`);
    return 2;
  }
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
    info = a.fixture ? M.loadFixture(a.fixture) : M.fetchLive(a.pr, a.repo || mc.repo || "", source, Boolean(prof && prof.high_paths.length));
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
  let lines: [string, string] | undefined;
  if (prof && "checks" in r) {
    try {
      const gh = M.githubApprovedAtHead(info);
      const pg = P.gateProfile(prof, {
        tierFlag: a.tier, auto: a.auto, files: M.changedFiles(info), githubApproved: gh,
        // a teammate's GitHub approval is a human review, never an agent review
        approvers: source === "comments" ? r.approved_by : gh.filter((l) => !P.isTeammate(prof, l)),
        authors: source === "comments" ? authors : [M.prAuthor(info)],
      });
      r.ok = r.ok && pg.ok;
      r.profile = pg.info;
      lines = [P.strengthLine(pg.info), P.verdictLine(r.ok, pg.info)];
    } catch (e: any) {
      println(io, `#${a.pr} => BLOCKED (unreadable PR data: ${e.message ?? e})`);
      return 1;
    }
  }
  if (r.malformed) eprintln(io, `merge-gate: warning: ${r.malformed} comment(s) look like ORCH-REVIEW lines but are malformed; they were not counted`);
  println(io, a.json ? dumps(r) : M.render(a.pr, r, lines));
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
  const cfg = C.loadOrDefault();
  const w = workers(cfg);
  try {
    const action = a._path[2];
    if (action === "start") {
      const prof = P.readProfile(cfg);
      if (prof && !a.force) {
        const cap = P.policyFor(prof, "high").workerCap;
        const running = w.list().filter((x) => x.state === "RUNNING").length;
        if (running >= cap) {
          eprintln(io, `worker: ${running} worker(s) running and the profile's worker cap is ${cap} (${P.cellLabel(prof)}); stop one, or pass --force`);
          return 2;
        }
      }
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

/** Key-order-independent JSON, for comparing parsed tables. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (isPlainObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

function showProfile(io: IO, cfg: Record<string, any>, json: boolean): number {
  const prof = P.readProfile(cfg);
  if (!prof) {
    println(io, json ? dumps({ profile: null }) : "profile: not set (merge gate uses the plain rule)");
    return 0;
  }
  const eff = P.effective(prof);
  const rows = P.capabilityRows(prof, profileEnv(cfg));
  const pol = (t: P.Tier) => {
    const x = P.policyFor(prof, t);
    return { need_agent: x.needAgent, need_teammate: x.needTeammate, authority: x.authority, worker_cap: x.workerCap };
  };
  const cell = P.cellOf(eff.compute, prof.people);
  const declared = P.cellOf(prof.compute, prof.people);
  const missing = rows.filter(([ok]) => !ok).map(([, name, detail]) => `${name}: ${detail}`);
  if (json) {
    println(io, dumps({
      cell, declared_cell: declared, compute: prof.compute, effective_compute: eff.compute, people: prof.people,
      lead_account: prof.lead_account, default_tier: prof.default_tier, high_paths: prof.high_paths, teammates: prof.teammates,
      accounts: prof.accounts, agents: prof.raw.agents ?? {}, max_workers: prof.max_workers, workers_per_account: prof.workers_per_account,
      policy: { low: pol("low"), high: pol("high") }, degraded: eff.degraded, missing,
    }));
    return 0;
  }
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  println(io, `profile: ${P.cellLabel(prof)}` + (declared !== cell ? `, declared cell ${declared} (${prof.compute} · ${prof.people})` : ""));
  println(io, `accounts: ${list(Object.entries(prof.accounts).map(([id, v]) => `${id} (${v})`))}` + (prof.lead_account ? `; lead ${prof.lead_account}` : ""));
  println(io, `agents: ${list(Object.entries<string>(prof.raw.agents ?? {}).map(([n, id]) => `${n}=${id}`))}`);
  println(io, `teammates: ${list(prof.teammates)}`);
  println(io, `tiers: default=${prof.default_tier} high_paths=${list(prof.high_paths)}`);
  for (const t of P.TIERS) {
    const x = pol(t);
    println(io, `${padEnd(t + ":", 5)} review=${x.need_agent} teammate=${x.need_teammate ? "yes" : "no"} authority=${x.authority} worker_cap=${x.worker_cap}`);
  }
  if (!missing.length) println(io, "missing: none");
  for (const m of missing) println(io, `missing: ${m}`);
  return 0;
}

/** NAME=VALUE pairs from a repeatable flag. */
function pairs(items: string[], flag: string): [string, string][] {
  return items.map((x) => {
    const i = x.indexOf("=");
    if (i <= 0 || i === x.length - 1) throw new C.ConfigError(`${flag} takes NAME=VALUE (got '${x}')`);
    const k = x.slice(0, i);
    if (["__proto__", "constructor", "prototype"].includes(k)) throw new C.ConfigError(`${flag}: the name '${k}' is not allowed`);
    return [k, x.slice(i + 1)];
  });
}

const cmdProfile: Run = (a, io) => {
  if (a._path[2] === "show") return showProfile(io, C.loadOrDefault(), a.json);
  const path = C.configPath();
  if (!existsSync(path)) {
    eprintln(io, `profile: ${path} missing - run \`orch init\` first`);
    return 2;
  }
  const text = readFileSync(path, "utf8");
  const cfg = parseToml(text);
  const fail = (m: string) => {
    eprintln(io, `profile: ${m}; nothing written`);
    return 2;
  };
  if (cfg.profile !== undefined && !isPlainObject(cfg.profile)) return fail("[profile] is not a table");
  if (cfg.profile === undefined && !(a.compute && a.people)) return fail("no [profile] yet: creating one needs both --compute and --people");
  const raw: Record<string, any> = structuredClone(cfg.profile ?? {});
  try {
    if (a.compute) raw.compute = a.compute;
    if (a.people) raw.people = a.people;
    if (a.default_tier) raw.default_tier = a.default_tier;
    if (a.lead_account) raw.lead_account = a.lead_account;
    if (a.max_workers !== null) raw.max_workers = a.max_workers;
    for (const [t, add, del, what] of [["accounts", pairs(a.account, "--account"), a.remove_account, "account"],
      ["agents", pairs(a.agent, "--agent"), a.remove_agent, "agent"]] as const) {
      if (!add.length && !del.length) continue;
      if (raw[t] !== undefined && !isPlainObject(raw[t])) return fail(`[profile.${t}] is not a table`);
      raw[t] = { ...(raw[t] ?? {}) };
      for (const [k, v] of add) raw[t][k] = v;
      for (const k of del) {
        if (!Object.hasOwn(raw[t], k)) return fail(`no ${what} '${k}' in [profile.${t}]`);
        delete raw[t][k];
      }
    }
    for (const [key, add, del, same] of [["teammates", a.teammate, a.remove_teammate, (x: string, y: string) => x.toLowerCase() === y.toLowerCase()],
      ["high_paths", a.high_path, a.remove_high_path, (x: string, y: string) => x === y]] as const) {
      if (!add.length && !del.length) continue;
      if (raw[key] !== undefined && !Array.isArray(raw[key])) return fail(`[profile] ${key} is not an array`);
      let cur: string[] = [...(raw[key] ?? [])];
      for (const x of add) if (!cur.some((y) => same(x, y))) cur.push(x);
      for (const x of del) {
        if (!cur.some((y) => same(x, y))) return fail(`'${x}' is not in [profile] ${key}`);
        cur = cur.filter((y) => !same(x, y));
      }
      raw[key] = cur;
    }
    // the rendering always has both sub-tables
    for (const t of ["accounts", "agents"]) raw[t] ??= {};
    P.readProfile({ profile: raw });
  } catch (e) {
    if (e instanceof C.ConfigError) return fail(e.message);
    throw e;
  }
  // replace only the profile tables, then prove it: the profile reads back as written and every other table is unchanged
  let next = "";
  let ok = false;
  try {
    next = P.writeProfileText(text, raw);
    const back = parseToml(next);
    const { profile: _old, ...before } = cfg;
    const { profile: now, ...after } = back;
    ok = canon(now) === canon(raw) && canon(before) === canon(after);
  } catch (e) {
    if (!(e instanceof TomlError)) throw e;
  }
  if (!ok) return fail("the profile could not be rewritten as [profile] tables in place (is it written as inline tables or dotted keys?)");
  if (a.dry_run) {
    io.out(P.renderProfile(raw));
    return 0;
  }
  atomicWrite(path, next, { mode: statSync(path).mode & 0o777 });
  println(io, `updated [profile] in ${path}`);
  return showProfile(io, parseToml(next), false);
};

// ---- the command tree -------------------------------------------------------------------------

const opt = (dest: string, flags: string[], kind: "bool" | "str" | "int" | "float" | "list", help: string, extra: Partial<{ metavar: string; choices: string[] }> = {}) =>
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
          opt("compute", ["--compute"], "str", "profile: the agent accounts (with --people; no questions)", { choices: P.COMPUTES }),
          opt("people", ["--people"], "str", "profile: who approves merges (with --compute)", { choices: P.PEOPLE }),
          opt("no_profile", ["--no-profile"], "bool", "on a terminal, skip the profile questions and write no [profile]"),
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
          opt("tier", ["--tier"], "str", "profile only: the PR's tier (default: [profile] high_paths, then default_tier)", { choices: P.TIERS }),
          opt("auto", ["--auto"], "bool", "profile only: the caller merges automatically on PASS; passes only under auto authority"),
          JSON_OPT,
        ],
      },
      {
        name: "profile", help: "the [profile] setup (accounts x people) and the review policy it gives",
        sub: [
          { name: "show", help: "cell, accounts, agents, the policy per tier, and missing capabilities", run: cmdProfile, opts: [JSON_OPT] },
          {
            name: "update", help: "change only the [profile] tables of config.toml", run: cmdProfile,
            usage: "orch profile update [--compute V] [--people V] [--account ID=VENDOR]... [--remove-account ID]... [--agent NAME=ID]... " +
              "[--remove-agent NAME]... [--teammate LOGIN]... [--remove-teammate LOGIN]... [--high-path GLOB]... [--remove-high-path GLOB]... " +
              "[--default-tier low|high] [--lead-account ID] [--max-workers N] [--dry-run]",
            opts: [
              opt("compute", ["--compute"], "str", "one, same-vendor or multi-vendor", { choices: P.COMPUTES }),
              opt("people", ["--people"], "str", "solo or team", { choices: P.PEOPLE }),
              opt("account", ["--account"], "list", "add or change an account: ID=VENDOR (repeatable)", { metavar: "ID=VENDOR" }),
              opt("remove_account", ["--remove-account"], "list", "remove an account (repeatable)", { metavar: "ID" }),
              opt("agent", ["--agent"], "list", "map an agent to an account: NAME=ID (repeatable)", { metavar: "NAME=ID" }),
              opt("remove_agent", ["--remove-agent"], "list", "remove an agent (repeatable)", { metavar: "NAME" }),
              opt("teammate", ["--teammate"], "list", "add a teammate GitHub login (repeatable)", { metavar: "LOGIN" }),
              opt("remove_teammate", ["--remove-teammate"], "list", "remove a teammate (repeatable)", { metavar: "LOGIN" }),
              opt("high_path", ["--high-path"], "list", "add a path glob that makes a PR high tier (repeatable)", { metavar: "GLOB" }),
              opt("remove_high_path", ["--remove-high-path"], "list", "remove a path glob (repeatable)", { metavar: "GLOB" }),
              opt("default_tier", ["--default-tier"], "str", "tier when neither --tier nor a path rule decides", { choices: P.TIERS }),
              opt("lead_account", ["--lead-account"], "str", "the account the lead runs on", { metavar: "ID" }),
              opt("max_workers", ["--max-workers"], "int", "worker cap (0 = derived from the cell)", { metavar: "N" }),
              opt("dry_run", ["--dry-run"], "bool", "print the new tables; write nothing"),
            ],
          },
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
