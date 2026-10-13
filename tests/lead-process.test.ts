// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch lead` as real processes: the compiled CLI (dist/cli.js, built by `npm test`) and the CLI
// installed from a packed tarball. A preload module, written to a temporary directory at run time,
// records every file, process and network call of the child in order, can hold the child at a
// named point (a barrier: the child blocks on its standard input until the test releases or kills
// it) and can shorten one write. Every child has a kill deadline below 60 seconds; there is no
// sleep and no polling loop.
//
// Measured on macOS. On Windows these tests are skipped unless ORCH_LEAD_UNMEASURED=1 is set:
// nothing in this file is native Windows proof.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { COMMAND_BUDGET_MS } from "../src/lead/pack.js";
import { DIST_CLI, ROOT, WINDOWS } from "./_helpers.js";
import { candidate, npmCommand, pack } from "./_pack.js";

const RUN = !WINDOWS || process.env.ORCH_LEAD_UNMEASURED === "1";
const FROZEN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-reviewed-text.json"), "utf8"));
const CHILD_DEADLINE_MS = 25_000;

type Host = "claude" | "codex";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const dests = (host: Host): string[] => FROZEN.inventory[host].map((row: string[]) => row[1]);
const sourceOf = (host: Host, dest: string): string => FROZEN.inventory[host].find((row: string[]) => row[1] === dest)[0];
const reviewedBytes = (host: Host, dest: string) => readFileSync(join(ROOT, ...sourceOf(host, dest).split("/")));
const anchorOf = (host: Host, dest: string) => `.orch-lead-install/objects/${String(dests(host).indexOf(dest)).padStart(2, "0")}`;
const BOOT: Record<Host, string> = { claude: "CLAUDE.md", codex: "AGENTS.md" };
const ROOT_OF: Record<Host, string> = { claude: ".claude/skills/orch-lead", codex: ".agents/skills/orch-lead" };
const PARENTS: Record<Host, string[]> = { claude: [".claude", ".claude/skills"], codex: [".agents", ".agents/skills"] };
/** The directories install creates in an empty workspace, outermost first. */
const createdDirs = (host: Host) => [...PARENTS[host], ROOT_OF[host], `${ROOT_OF[host]}/agents`, `${ROOT_OF[host]}/workflows`];
const at = (workspace: string, rel: string) => join(workspace, ...rel.split("/"));

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix = "orch-lead-p-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
/** A fresh empty workspace inside its own scratch directory, with room beside it for other files. */
function workspace(): { base: string; w: string } {
  const base = tmp();
  const w = join(base, "work space");
  mkdirSync(w);
  return { base, w };
}

/** Every entry below `dir`: kind, relative path and content hash (or link target). Sorted. */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out.push(`link ${r} -> ${readlinkSync(join(dir, r))}`);
    else if (st.isDirectory()) out.push(`dir ${r}`, ...tree(dir, r));
    else if (st.isFile()) out.push(`file ${r} ${sha(readFileSync(join(dir, r)))}`);
    else out.push(`other ${r}`);
  }
  return out;
}
/** Device and inode of a path, or "absent". */
const idOf = (path: string) => {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return "absent";
  }
};
/** Content hash of a file, or "absent". */
const hashOf = (path: string) => {
  try {
    return sha(readFileSync(path));
  } catch {
    return "absent";
  }
};

// ---- the preload module ------------------------------------------------------------------------

const PRELOAD = String.raw`
import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const real = { openSync: fs.openSync, writeSync: fs.writeSync, readSync: fs.readSync };
const traceFd = process.env.LEAD_TEST_TRACE ? real.openSync(process.env.LEAD_TEST_TRACE, "a") : -1;
const rules = JSON.parse(process.env.LEAD_TEST_RULES || "[]");
const hits = new Map();
const fdPath = new Map();
let seq = 0;
function log(op, detail) {
  if (traceFd >= 0) real.writeSync(traceFd, JSON.stringify({ seq: ++seq, op, ...detail }) + "\n");
}
function norm(p) { return String(p).split("\\").join("/"); }
function matching(when, op, path) {
  const out = [];
  for (const rule of rules) {
    if (rule.op !== op || (rule.when || "before") !== when) continue;
    if (rule.match && !norm(path).endsWith(rule.match)) continue;
    const key = JSON.stringify(rule);
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n === (rule.nth || 1)) out.push(rule);
  }
  return out;
}
// A barrier: say where we are on stderr, then block until the test writes one byte to stdin.
// End of input without a byte means the test gave up: leave with a code no command uses.
function barrier(when, op, path) {
  for (const rule of matching(when, op, path)) {
    if (rule.action !== "block") continue;
    real.writeSync(2, "PHASE " + rule.name + "\n");
    const one = Buffer.alloc(1);
    let got = 0;
    try { got = real.readSync(0, one, 0, 1, null); } catch (e) { got = 0; }
    if (got !== 1) process.exit(97);
  }
}

const TWO_PATHS = new Set(["linkSync", "renameSync", "copyFileSync", "symlinkSync", "cpSync"]);
const MUTATING = ["mkdirSync", "linkSync", "unlinkSync", "rmdirSync", "rmSync", "renameSync", "writeFileSync", "appendFileSync",
  "copyFileSync", "cpSync", "symlinkSync", "truncateSync", "chmodSync", "lchmodSync", "chownSync", "lchownSync", "utimesSync", "lutimesSync", "mkdtempSync"];
const READING = ["lstatSync", "statSync", "readFileSync", "readdirSync", "readlinkSync", "existsSync", "accessSync", "opendirSync"];
for (const name of [...MUTATING, ...READING]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  const mutating = MUTATING.includes(name);
  fs[name] = function (...args) {
    const path = norm(args[0]);
    const path2 = TWO_PATHS.has(name) ? norm(args[1]) : undefined;
    barrier("before", name, path2 ?? path);
    let code = "OK";
    try {
      return original.apply(this, args);
    } catch (e) {
      code = (e && e.code) || "THROW";
      throw e;
    } finally {
      log(name, { path, path2, mutating, code });
      if (code === "OK") barrier("after", name, path2 ?? path);
    }
  };
}
const nativeRealpath = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  log("realpathSync.native", { path: norm(args[0]), mutating: false, code: "OK" });
  return nativeRealpath.apply(this, args);
};
const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
fs.openSync = function (...args) {
  const path = norm(args[0]);
  const flags = args[1];
  const mutating = typeof flags === "number" ? (flags & WRITE_BITS) !== 0 : flags !== undefined && flags !== "r";
  barrier("before", "openSync", path);
  let code = "OK";
  try {
    const fd = real.openSync.apply(this, args);
    fdPath.set(fd, path);
    return fd;
  } catch (e) {
    code = (e && e.code) || "THROW";
    throw e;
  } finally {
    log("openSync", { path, mutating, code });
  }
};
fs.writeSync = function (fd, buffer, offset, length, ...rest) {
  if (fd === 1 || fd === 2 || fd === traceFd || !fdPath.has(fd)) return real.writeSync.call(this, fd, buffer, offset, length, ...rest);
  const path = fdPath.get(fd);
  barrier("before", "writeSync", path);
  for (const rule of matching("short", "writeSync", path)) length = Math.min(length, rule.bytes);
  const n = real.writeSync.call(this, fd, buffer, offset, length, ...rest);
  log("writeSync", { path, mutating: true, code: "OK", bytes: n });
  return n;
};
for (const name of ["ftruncateSync", "fchmodSync", "fchownSync", "futimesSync"]) {
  const original = fs[name];
  fs[name] = function (fd, ...rest) {
    log(name, { path: fdPath.get(fd) || "fd:" + fd, mutating: true, code: "OK" });
    return original.call(this, fd, ...rest);
  };
}
// Callback and promise forms: the commands under test use none, so any call is recorded as is.
const ASYNC = ["mkdir", "link", "unlink", "rmdir", "rm", "rename", "writeFile", "appendFile", "copyFile", "cp", "symlink", "truncate",
  "chmod", "chown", "utimes", "mkdtemp", "open", "write", "createWriteStream"];
for (const holder of [fs, fs.promises]) {
  for (const name of ASYNC) {
    const original = holder[name];
    if (typeof original !== "function") continue;
    holder[name] = function (...args) {
      log("async:" + name, { path: norm(args[0]), mutating: true, code: "CALLED" });
      return original.apply(this, args);
    };
  }
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    log("process", { path: String(args[0]), call: name });
    return original.apply(this, args);
  };
}
// Network: recorded and refused, so a test never opens a connection.
const refuse = (what) => function (...args) {
  log("network", { call: what, path: "" });
  throw new Error("network use is blocked in this test: " + what);
};
net.Socket.prototype.connect = refuse("net.connect");
dgram.createSocket = refuse("dgram.createSocket");
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) dns[name] = refuse("dns." + name);
globalThis.fetch = refuse("fetch");
const realKill = process.kill;
process.kill = function (pid, signal) {
  log("kill", { path: "", pid, signal: signal === undefined ? "SIGTERM" : signal });
  return realKill.call(this, pid, signal);
};
const out = process.stdout;
const realOut = out.write;
out.write = function (chunk, encoding, callback) {
  if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
  log("stdout.write", { path: "", text: String(chunk) });
  return realOut.call(out, chunk, encoding, (error) => {
    log("stdout.done", { path: "", code: error ? error.code || "ERROR" : "OK" });
    if (callback) callback(error);
  });
};
// A barrier at the end: the command has done all its work and printed its result, and its
// process id is still in use until the test releases it.
process.on("exit", () => barrier("before", "exit", ""));
syncBuiltinESMExports();
log("preload", { path: "" });
barrier("before", "start", "");
`;

let preloadUrl = "";
function preload(): string {
  if (!preloadUrl) {
    const dir = tmp("orch-lead-preload-");
    writeFileSync(join(dir, "preload.mjs"), PRELOAD);
    preloadUrl = pathToFileURL(join(dir, "preload.mjs")).href;
  }
  return preloadUrl;
}

interface Ev { seq: number; op: string; path: string; path2?: string; mutating?: boolean; code?: string; text?: string; signal?: unknown; pid?: number; call?: string }
interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; trace: Ev[] }
interface Rule { op: string; when?: "before" | "after" | "short"; match?: string; nth?: number; action?: "block"; name?: string; bytes?: number }
interface Session {
  child: ChildProcess;
  /** True once the child printed this phase; false if it ended first. */
  phase(name: string): Promise<boolean>;
  release(): void;
  kill(): void;
  done: Promise<Result>;
}

const isolated = tmp("orch-lead-env-");
/** Environment of every child: a home and an ORCH home that do not exist and must stay that way. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(isolated, "home"), USERPROFILE: join(isolated, "home"), ORCH_HOME: join(isolated, "orch-home") };
  for (const key of ["SystemRoot", "TEMP", "TMP", "TMPDIR", "PATHEXT", "ComSpec"]) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

/** Start `command args` with the preload; rules are barriers and short writes. */
function start(command: string, args: string[], rules: Rule[] = [], extraEnv: Record<string, string> = {}, cwd = isolated): Session {
  const traceFile = join(tmp("orch-lead-trace-"), "trace.jsonl");
  const viaNode = command === process.execPath;
  const child = spawn(command, viaNode ? ["--import", preload(), ...args] : args, {
    cwd, stdio: ["pipe", "pipe", "pipe"], timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL",
    env: childEnv({ LEAD_TEST_TRACE: traceFile, LEAD_TEST_RULES: JSON.stringify(rules), ...(viaNode ? {} : { NODE_OPTIONS: `--import=${preload()}` }), ...extraEnv }),
  });
  let stdout = "";
  let stderr = "";
  const waiting: (() => void)[] = [];
  let ended = false;
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
    for (const wake of waiting.splice(0)) wake();
  });
  child.stdin!.on("error", () => {});
  const done = new Promise<Result>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      ended = true;
      for (const wake of waiting.splice(0)) wake();
      const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Ev) : [];
      // Without the first line of the trace nothing was observed, and "no call was seen" would mean nothing.
      if (trace[0]?.op !== "preload") reject(new Error(`the child was not instrumented: no trace\n${stderr}`));
      else resolve({ code, signal, stdout, stderr, trace });
    });
  });
  if (!rules.some((rule) => rule.action === "block")) child.stdin!.end();
  return {
    child, done,
    async phase(name) {
      for (;;) {
        if (stderr.includes(`PHASE ${name}\n`)) return true;
        if (ended) return false;
        await new Promise<void>((wake) => waiting.push(wake));
      }
    },
    release: () => void child.stdin!.write("x"),
    kill: () => void child.kill("SIGKILL"),
  };
}
const lead = (args: string[], rules: Rule[] = [], env: Record<string, string> = {}) => start(process.execPath, [DIST_CLI, "lead", ...args], rules, env);
const run = (args: string[], env: Record<string, string> = {}) => lead(args, [], env).done;
const mutations = (r: Result) => r.trace.filter((ev) => ev.mutating);
const describeMutations = (r: Result) => mutations(r).map((ev) => `${ev.op} ${ev.path2 ?? ev.path} ${ev.code}`);
/** Row states printed by status, keyed by workspace-relative path with `/`. */
function rowStates(stdout: string, w: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^ {2}(OWNED_MATCH|OWNED_CHANGED|MISSING|FOREIGN|UNVERIFIABLE)\s+(.+?)(?: {2}\(.*\))?$/.exec(line);
    if (m && m[2].startsWith(w + sep)) out[m[2].slice(w.length + 1).split(sep).join("/")] = m[1];
  }
  return out;
}
const resultOf = (stdout: string) => /^result: (\w+)$/m.exec(stdout)?.[1] ?? "";

/** The manifest text, written here independently of the implementation. */
function manifestText(host: Host, w: string, pid: number, rows?: { path: string; sha256: string; anchor: string }[]): string {
  const list = rows ?? dests(host).map((dest, i) => ({ path: dest, sha256: FROZEN.sources[sourceOf(host, dest)] as string, anchor: `objects/${String(i).padStart(2, "0")}` }));
  return `{"schema":1,"host":${JSON.stringify(host)},"workspace":${JSON.stringify(w)},"pack":"${FROZEN.pack_hash[host]}","pid":${pid},"rows":[\n`
    + list.map((r) => `    {"path":${JSON.stringify(r.path)},"sha256":"${r.sha256}","anchor":"${r.anchor}"}`).join(",\n") + "\n]}\n";
}
/** The id of a process that has already ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  return r.pid;
}

// ---- the packed CLI ----------------------------------------------------------------------------

interface Packed { dir: string; tarball: string; tarballSha: string; files: string[]; prefix: string; shim: string; env: Record<string, string>; outside: string; extracted: string }
let packedMemo: Packed | undefined;
/** Pack a disposable copy of this source, install the tarball offline into a private prefix. Once per file. */
function packed(): Packed {
  if (packedMemo) return packedMemo;
  const copy = candidate(scratch);
  const tarball = pack(copy);
  const files = copy.run("tar", ["-tzf", tarball]).trim().split("\n").sort();
  const extracted = join(copy.dir, "extracted");
  mkdirSync(extracted);
  copy.run("tar", ["-xzf", tarball, "-C", extracted]);
  const prefix = join(copy.dir, "prefix");
  const temp = join(copy.dir, "tmp");
  const outside = join(copy.dir, "elsewhere");
  for (const dir of [temp, outside]) mkdirSync(dir);
  const env = { HOME: copy.home, USERPROFILE: copy.home, ORCH_HOME: join(copy.dir, "orch-home"), TMPDIR: temp, TEMP: temp, TMP: temp, GIT_DIR: join(copy.dir, "no-such-git-dir") };
  const installed = spawnSync(npmCommand, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, "-g", tarball],
    { cwd: outside, env: { ...copy.env, ...env }, encoding: "utf8", timeout: 50_000, shell: WINDOWS });
  expect(installed.status, `npm install -g of the tarball\n${installed.stdout}\n${installed.stderr}`).toBe(0);
  packedMemo = {
    dir: copy.dir, tarball, tarballSha: sha(readFileSync(tarball)), files, prefix, shim: WINDOWS ? join(prefix, "orch.cmd") : join(prefix, "bin", "orch"),
    env: { ...env, PATH: [dirname(process.execPath), ...(WINDOWS ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"])].join(delimiter) },
    outside, extracted,
  };
  return packedMemo;
}
/** Run the installed `orch` entry: the real shim, from a directory outside the checkout. */
function orch(p: Packed, args: string[]): Promise<Result> {
  return start(p.shim, args, [], p.env, p.outside).done;
}

describe.skipIf(!RUN)("orch lead: real processes", () => {
  it("lead_stalled_output_ends_within_budget", async () => {
    const out = workspace();
    const err = workspace();
    mkdirSync(at(out.w, ".orch-lead-install"));
    for (let i = 0; i < 1_800; i++) {
      writeFileSync(at(out.w, `.orch-lead-install/${String(i).padStart(4, "0")}-${"x".repeat(180)}`), "");
    }
    const unread = (stream: "stdout" | "stderr", w: string, host: string) => {
      const traceFile = join(tmp("orch-lead-stall-"), "trace.jsonl");
      const began = performance.now();
      const child = spawn(process.execPath, ["--import", preload(), DIST_CLI, "lead", "status", "--workspace", w, "--host", host], {
        cwd: isolated, stdio: ["ignore", "pipe", "pipe"],
        env: childEnv({ LEAD_TEST_TRACE: traceFile }),
      });
      child[stream === "stdout" ? "stderr" : "stdout"]!.on("data", () => {});
      return new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsed: number; trace: Ev[] }>((resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_BUDGET_MS + 8_000);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Ev) : [];
          resolve({ code, signal, elapsed: performance.now() - began, trace });
        });
      });
    };
    const results = await Promise.all([
      unread("stdout", out.w, "codex"),
      unread("stderr", err.w, "x" + "\u200d".repeat(60_000)),
    ]);
    for (const [i, r] of results.entries()) {
      const stream = i === 0 ? "stdout" : "stderr";
      console.log(`[observation] stalled ${stream}: code=${r.code}, signal=${r.signal}, elapsed_ms=${Math.round(r.elapsed)}`);
      expect(r.trace[0]?.op, `${stream}: the child was instrumented`).toBe("preload");
      expect.soft([r.code, r.signal], `[stalled-output-ends] unread ${stream}: exits 1 without a signal`).toEqual([1, null]);
      expect.soft(r.elapsed, `[stalled-output-ends] unread ${stream}: ends within the budget plus 5 seconds`).toBeLessThan(COMMAND_BUDGET_MS + 5_000);
      expect.soft(r.trace.filter((ev) => ev.mutating), `[stalled-output-ends] unread ${stream}: no mutating call`).toEqual([]);
    }
  }, 45_000);

  it("lead_real_cli_has_install_status_uninstall", async () => {
    const p = packed();
    const { w } = workspace();
    const help = await orch(p, ["lead", "--help"]);
    expect.soft(help.code, `[real-cli] the packed orch has the lead command\n${help.stderr}`).toBe(0);
    for (const name of ["install", "status", "uninstall"]) expect.soft(help.stdout, `[real-cli] help lists ${name}`).toMatch(new RegExp(`^  ${name} `, "m"));
    const args = ["--workspace", w, "--host", "claude"];

    const usage = await orch(p, ["lead", "install", "--workspace", w]);
    expect.soft([usage.code, tree(w)], `[exit-codes] wrong usage exits 1 and creates nothing\n${usage.stderr}`).toEqual([1, []]);

    const install = await orch(p, ["lead", "install", ...args]);
    expect.soft([install.code, resultOf(install.stdout)], `[real-cli] install runs\n${install.stdout}\n${install.stderr}`).toEqual([0, "INSTALLED"]);
    expect.soft(install.code, "[exit-codes] a complete install exits 0").toBe(0);
    const status = await orch(p, ["lead", "status", ...args]);
    expect.soft([status.code, resultOf(status.stdout)], `[real-cli] status runs\n${status.stdout}\n${status.stderr}`).toEqual([0, "INSTALLED"]);
    expect.soft(status.stdout.trimEnd().split("\n").pop(), "[activation-unverified] status ends with the activation line").toBe("host activation: unverified");

    const again = await orch(p, ["lead", "install", ...args]);
    expect.soft([again.code, resultOf(again.stdout)], `[exit-codes] a conflict exits 2\n${again.stdout}`).toEqual([2, "CONFLICT"]);

    const uninstall = await orch(p, ["lead", "uninstall", ...args]);
    expect.soft([uninstall.code, resultOf(uninstall.stdout)], `[real-cli] uninstall runs\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
    // The files, the state and the directories install created are gone.
    expect.soft(tree(w), "[clean-uninstall] uninstall leaves nothing in a workspace that was empty before install").toEqual([]);
    const after = await orch(p, ["lead", "status", ...args]);
    expect.soft([after.code, resultOf(after.stdout)], "[real-cli] status after uninstall").toEqual([0, "NOT_INSTALLED"]);
    const reinstall = await orch(p, ["lead", "install", ...args]);
    expect.soft([reinstall.code, resultOf(reinstall.stdout)], `[reinstall-works] install for the same host works again after uninstall\n${reinstall.stdout}\n${reinstall.stderr}`).toEqual([0, "INSTALLED"]);
  });

  it("lead_packed_tarball_runs_without_checkout", async () => {
    const p = packed();
    // The tarball carries exactly the 21 reviewed text files of the pack, byte for byte.
    const packedTemplates = p.files.filter((f) => /^package\/templates\/(lead|workflows)\//.test(f)).map((f) => f.slice("package/".length));
    expect.soft(packedTemplates, "[packed-inventory] template files in the tarball").toEqual(Object.keys(FROZEN.sources).sort());
    const installedRoot = WINDOWS ? join(p.prefix, "node_modules", "orch-os") : join(p.prefix, "lib", "node_modules", "orch-os");
    for (const [source, hash] of Object.entries(FROZEN.sources as Record<string, string>)) {
      expect.soft([sha(readFileSync(join(p.extracted, "package", ...source.split("/")))), sha(readFileSync(join(installedRoot, ...source.split("/")))), sha(readFileSync(join(ROOT, ...source.split("/"))))],
        `[packed-inventory] ${source}: tarball, installed package and source all have the reviewed hash`).toEqual([hash, hash, hash]);
    }
    expect(p.shim.startsWith(ROOT + sep), "the installed entry is outside the checkout").toBe(false);
    const homeBefore = [tree(p.env.HOME), existsSync(p.env.ORCH_HOME), existsSync(p.env.GIT_DIR)];
    const all: Result[] = [];
    for (const host of ["claude", "codex"] as Host[]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      const install = await orch(p, ["lead", "install", ...args]);
      expect.soft([install.code, resultOf(install.stdout)], `[packed-install] ${host}: install from the packed CLI\n${install.stdout}\n${install.stderr}`).toEqual([0, "INSTALLED"]);
      const expected = dests(host).map((dest) => `file ${dest} ${FROZEN.sources[sourceOf(host, dest)]}`).sort();
      expect.soft(tree(w).filter((line) => line.startsWith("file ") && !line.includes(".orch-lead-install/")).sort(), `[packed-install] ${host}: installed files and their hashes`).toEqual(expected);
      expect.soft(install.trace.filter((ev) => ev.op === "linkSync" && ev.code === "OK").length, `[packed-install] ${host}: the packed command was observed making its 21 links`).toBe(21);
      const status = await orch(p, ["lead", "status", ...args]);
      expect.soft([status.code, resultOf(status.stdout)], `[packed-install] ${host}: status`).toEqual([0, "INSTALLED"]);
      const conflict = await orch(p, ["lead", "install", ...args]);
      expect.soft([conflict.code, resultOf(conflict.stdout), describeMutations(conflict)], `[packed-install] ${host}: a second install is a conflict without writes`).toEqual([2, "CONFLICT", []]);
      const uninstall = await orch(p, ["lead", "uninstall", ...args]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], `[packed-install] ${host}: uninstall\n${uninstall.stdout}`).toEqual([0, "NOT_INSTALLED"]);
      expect.soft(tree(w), `[packed-install] ${host}: nothing is left`).toEqual([]);
      all.push(install, status, conflict, uninstall);
      // Every write of every command was inside the workspace.
      for (const r of all.slice(-4)) {
        expect.soft(mutations(r).filter((ev) => !(ev.path2 ?? ev.path).startsWith(w.split(sep).join("/") + "/")).map((ev) => `${ev.op} ${ev.path}`), "[packed-no-outside-writes]").toEqual([]);
      }
    }
    const events = all.flatMap((r) => r.trace);
    expect.soft(events.filter((ev) => ev.op === "process").map((ev) => `${ev.call} ${ev.path}`), "[packed-no-process] the installed commands start no program").toEqual([]);
    expect.soft(events.filter((ev) => ev.op === "network").map((ev) => ev.call), "[packed-no-network] the installed commands make no network call").toEqual([]);
    expect.soft(events.filter((ev) => ev.op === "kill" && ev.signal !== 0).map((ev) => String(ev.signal)), "[packed-no-process] no signal is sent").toEqual([]);
    const checkout = ROOT.split(sep).join("/") + "/";
    expect.soft(events.filter((ev) => typeof ev.path === "string" && ev.path.startsWith(checkout)).map((ev) => `${ev.op} ${ev.path}`), "[packed-no-checkout] nothing in the checkout is touched").toEqual([]);
    expect.soft([tree(p.env.HOME), existsSync(p.env.ORCH_HOME), existsSync(p.env.GIT_DIR)], "[packed-no-home-writes] home, ORCH home and git directory are untouched").toEqual(homeBefore);
    console.log(`[observation] ${process.platform}: packed tarball sha256 ${p.tarballSha}; ${p.files.length} files; entry ${WINDOWS ? "orch.cmd" : "bin/orch"}`);
  });

  it("lead_loader_and_cli_have_no_unrequested_effects", async () => {
    const { base, w } = workspace();
    const { w: taken } = workspace();
    writeFileSync(join(taken, "CLAUDE.md"), "mine\n");
    const linked = join(base, "link-to-workspace");
    symlinkSync(w, linked, "dir");
    const templatesBefore = tree(join(ROOT, "templates"));
    const args = ["--workspace", w, "--host", "claude"];
    const inside = (r: Result, root: string) => mutations(r).filter((ev) => !(ev.path2 ?? ev.path).startsWith(root.split(sep).join("/") + "/")).map((ev) => `${ev.op} ${ev.path}`);

    // Refusals and read-only commands: no mutating call at all.
    const quiet: [string, Result, number][] = [
      ["wrong usage", await run(["install", "--workspace", w]), 1],
      ["conflict", await run(["install", "--workspace", taken, "--host", "claude"]), 2],
      ["dry run", await run(["install", ...args, "--dry-run"]), 0],
      ["status", await run(["status", ...args]), 0],
      ["uninstall with nothing installed", await run(["uninstall", ...args]), 0],
    ];
    for (const [name, r, code] of quiet) {
      expect.soft([r.code, describeMutations(r)], `[no-unrequested-writes] ${name}: exit code and mutating calls\n${r.stderr}`).toEqual([code, []]);
    }
    const absent = await run(["install", "--workspace", join(base, "absent"), "--host", "claude"]);
    expect.soft([absent.code, describeMutations(absent), existsSync(join(base, "absent"))], `[workspace-must-exist] a workspace that does not exist is refused and not created\n${absent.stderr}`).toEqual([1, [], false]);
    const viaLink = await run(["install", "--workspace", linked, "--host", "claude"]);
    expect.soft([viaLink.code, describeMutations(viaLink), tree(w)], `[workspace-refused] a workspace given as a link is refused\n${viaLink.stdout}`).toEqual([1, [], []]);

    const install = await run(["install", ...args]);
    expect.soft(install.code, install.stdout + install.stderr).toBe(0);
    expect.soft(inside(install, w), "[no-unrequested-writes] install writes only inside the workspace").toEqual([]);
    // The loader opens exactly the 20 packaged files of this host, read-only.
    const templates = join(ROOT, "templates").split(sep).join("/") + "/";
    expect.soft(install.trace.filter((ev) => ev.op === "openSync" && ev.path.startsWith(templates)).map((ev) => `${ev.path.slice(templates.length - "templates/".length)} ${ev.mutating}`).sort(),
      "[loader-reads-only-inventory]").toEqual(FROZEN.inventory.claude.map((row: string[]) => `${row[0]} false`).sort());
    const status = await run(["status", ...args]);
    expect.soft([status.code, describeMutations(status)], "[status-reads-only] status makes no mutating call").toEqual([0, []]);
    expect.soft(status.trace.filter((ev) => ev.path.startsWith(templates)).map((ev) => ev.path), "status does not read the packaged text").toEqual([]);
    const uninstall = await run(["uninstall", ...args]);
    expect.soft(uninstall.code, uninstall.stdout + uninstall.stderr).toBe(0);
    expect.soft(inside(uninstall, w), "[no-unrequested-writes] uninstall writes only inside the workspace").toEqual([]);

    const everything = [...quiet.map(([, r]) => r), absent, viaLink, install, status, uninstall];
    const events = everything.flatMap((r) => r.trace);
    expect.soft(events.filter((ev) => ev.op === "process").map((ev) => `${ev.call} ${ev.path}`), "[no-process] no program is started").toEqual([]);
    expect.soft(events.filter((ev) => ev.op === "kill" && ev.signal !== 0).map((ev) => String(ev.signal)), "[no-process] no signal is sent").toEqual([]);
    expect.soft(events.filter((ev) => ev.op === "network").map((ev) => ev.call), "[no-network] no network call is made").toEqual([]);
    expect.soft(events.filter((ev) => ev.op.startsWith("async:")).map((ev) => ev.op), "no callback or promise file call is made").toEqual([]);
    const orchHome = join(isolated, "orch-home").split(sep).join("/");
    expect.soft(events.filter((ev) => typeof ev.path === "string" && ev.path.startsWith(orchHome)).map((ev) => `${ev.op} ${ev.path}`), "[no-orch-home] the ORCH home is never touched").toEqual([]);
    expect.soft([existsSync(join(isolated, "orch-home")), existsSync(join(isolated, "home"))], "[no-orch-home] neither home was created").toEqual([false, false]);
    expect.soft(tree(join(ROOT, "templates")), "[no-unrequested-writes] the packaged text is unchanged").toEqual(templatesBefore);
  });

  it("lead_preflight_conflict_has_zero_mutations", async () => {
    const cases: { host: Host; label: string; place(w: string): string }[] = [];
    const file = (host: Host, dest: string, kind: "other bytes" | "identical bytes" | "dangling link") => cases.push({
      host, label: `${host}: ${kind} at ${dest}`,
      place(w) {
        mkdirSync(dirname(at(w, dest)), { recursive: true });
        if (kind === "dangling link") symlinkSync(join(w, "nowhere"), at(w, dest));
        else writeFileSync(at(w, dest), kind === "identical bytes" ? reviewedBytes(host, dest) : "the user's own text\n");
        return at(w, dest);
      },
    });
    for (const dest of dests("claude")) for (const kind of ["other bytes", "identical bytes", "dangling link"] as const) file("claude", dest, kind);
    for (const dest of [BOOT.codex, `${ROOT_OF.codex}/SKILL.md`, `${ROOT_OF.codex}/workflows/memory.md`]) for (const kind of ["other bytes", "identical bytes", "dangling link"] as const) file("codex", dest, kind);
    const other = (host: Host, label: string, place: (w: string) => string) => cases.push({ host, label: `${host}: ${label}`, place });
    other("claude", "state directory exists", (w) => (mkdirSync(at(w, ".orch-lead-install")), at(w, ".orch-lead-install")));
    other("claude", "state path is a file", (w) => (writeFileSync(at(w, ".orch-lead-install"), "x"), at(w, ".orch-lead-install")));
    other("claude", "state path is a dangling link", (w) => (symlinkSync(join(w, "nowhere"), at(w, ".orch-lead-install")), at(w, ".orch-lead-install")));
    other("claude", "empty pack directory exists", (w) => (mkdirSync(at(w, ROOT_OF.claude), { recursive: true }), at(w, ROOT_OF.claude)));
    other("codex", "empty pack directory exists", (w) => (mkdirSync(at(w, ROOT_OF.codex), { recursive: true }), at(w, ROOT_OF.codex)));
    other("claude", "shared parent is a file", (w) => (writeFileSync(at(w, ".claude"), "x"), at(w, ".claude")));
    other("claude", "shared parent is a link to a directory", (w) => {
      mkdirSync(join(w, "real-skills"));
      mkdirSync(at(w, ".claude"));
      symlinkSync(join(w, "real-skills"), at(w, ".claude/skills"), "dir");
      return at(w, ".claude/skills");
    });
    expect(cases.length).toBe(20 * 3 + 9 + 7);
    for (const c of cases) {
      const { w } = workspace();
      const obstacle = c.place(w);
      const before = tree(w);
      const r = await run(["install", "--workspace", w, "--host", c.host]);
      expect.soft([r.code, resultOf(r.stdout), r.stdout.includes(`  ${obstacle}  (`)], `[conflict-reported] ${c.label}: exit 2, CONFLICT, the path is named\n${r.stdout}\n${r.stderr}`).toEqual([2, "CONFLICT", true]);
      expect.soft(describeMutations(r), `[zero-mutations] ${c.label}: mutating file calls`).toEqual([]);
      expect.soft(tree(w), `[user-bytes-remain] ${c.label}: the workspace is unchanged`).toEqual(before);
    }
    // The other host in the same workspace is a conflict too: one workspace, one host.
    const { w } = workspace();
    expect((await run(["install", "--workspace", w, "--host", "claude"])).code).toBe(0);
    const before = tree(w);
    const second = await run(["install", "--workspace", w, "--host", "codex"]);
    expect.soft([second.code, resultOf(second.stdout), describeMutations(second), tree(w)], "[conflict-reported] the other host in the same workspace").toEqual([2, "CONFLICT", [], before]);

    for (const target of [".claude/skills", ".orch-lead-install"]) {
      const { base, w: linked } = workspace();
      const outside = join(base, `outside-${target.replaceAll("/", "-")}`);
      mkdirSync(outside);
      mkdirSync(join(outside, target === ".orch-lead-install" ? "objects" : "orch-lead"));
      if (target === ".claude/skills") mkdirSync(at(linked, ".claude"));
      symlinkSync(outside, at(linked, target), "dir");
      const linkedPrefix = at(linked, target).split(sep).join("/");
      const behind = (r: Result) => r.trace.filter((ev) => [ev.path, ev.path2].some((p) => typeof p === "string" && p.startsWith(`${linkedPrefix}/`)));
      const installResult = await run(["install", "--workspace", linked, "--host", "claude"]);
      expect.soft([installResult.code, resultOf(installResult.stdout), describeMutations(installResult), behind(installResult), installResult.stdout.includes(at(linked, target))],
        `[preflight-stops-at-link] ${target}: install names the link, creates nothing and makes no file call behind it`).toEqual([2, "CONFLICT", [], [], true]);
      if (target === ".claude/skills") {
        const status = await run(["status", "--workspace", linked, "--host", "claude"]);
        expect.soft(behind(status), "[preflight-stops-at-link] status with absent state makes no file call behind the shared-parent link").toEqual([]);
      }
    }
  });

  it("lead_prints_every_path_before_first_mutation", async () => {
    const { w } = workspace();
    const expected = [
      ".claude", ".claude/skills", ".claude/skills/orch-lead", ".claude/skills/orch-lead/agents", ".claude/skills/orch-lead/workflows",
      ".orch-lead-install", ".orch-lead-install/complete", ".orch-lead-install/directories.json", ".orch-lead-install/manifest.json", ".orch-lead-install/manifest.tmp",
      ".orch-lead-install/objects", ...dests("claude"), ...dests("claude").map((dest) => anchorOf("claude", dest)),
    ].map((rel) => at(w, rel)).sort();
    const printedPaths = (text: string) => text.split("\n").map((line) => /^ {2}(?:directory|file|state|temporary)\s+(.+)$/.exec(line)?.[1]).filter(Boolean);

    const dry = await run(["install", "--workspace", w, "--host", "claude", "--dry-run"]);
    expect.soft([dry.code, describeMutations(dry), tree(w)], `[dry-run-creates-nothing] exit code, mutating calls, workspace\n${dry.stderr}`).toEqual([0, [], []]);
    expect.soft([...printedPaths(dry.stdout)].sort(), "[print-before-mutation] the dry run prints every path").toEqual(expected);
    expect.soft(printedPaths(dry.stdout), "[code-point-order] the printed paths are in code-point order").toEqual([...printedPaths(dry.stdout)].sort());

    const r = await run(["install", "--workspace", w, "--host", "claude"]);
    expect.soft(r.code, r.stdout + r.stderr).toBe(0);
    const firstMutation = r.trace.findIndex((ev) => ev.mutating);
    const earlier = r.trace.slice(0, Math.max(firstMutation, 0));
    const printedBefore = printedPaths(earlier.filter((ev) => ev.op === "stdout.write").map((ev) => ev.text).join(""));
    expect.soft(firstMutation, "the install makes mutating calls").toBeGreaterThan(0);
    expect.soft([...printedBefore].sort(), "[print-before-mutation] every path is printed before the first mutating call").toEqual(expected);
    expect.soft(earlier.filter((ev) => ev.op === "stdout.done").map((ev) => ev.code), "[print-before-mutation] the list was written successfully before the first mutating call").toEqual(["OK"]);
    expect.soft(r.trace.filter((ev) => ev.op === "linkSync" && ev.code === "OK").map((ev) => ev.path2).pop(), "[bootstrap-last] the bootstrap file is the last file published").toBe(at(w, BOOT.claude).split(sep).join("/"));
    const created = new Set(mutations(r).filter((ev) => ev.code === "OK" && ev.op !== "unlinkSync").map((ev) => (ev.path2 ?? ev.path).split("/").join(sep)));
    expect.soft([...created].sort(), "[print-before-mutation] nothing is created that was not printed").toEqual(expected);

    // Standard output is closed before the command starts printing: no mutation, exit 1.
    const { w: closed } = workspace();
    const s = lead(["install", "--workspace", closed, "--host", "claude"], [{ op: "start", action: "block", name: "START" }]);
    expect(await s.phase("START"), "the child reached its first line").toBe(true);
    const closedEvent = new Promise<void>((resolve) => s.child.stdout!.once("close", () => resolve()));
    s.child.stdout!.destroy();
    await closedEvent;
    s.release();
    s.child.stdin!.end();
    const result = await s.done;
    expect.soft([result.code, describeMutations(result), tree(closed)], `[closed-pipe-no-mutation] exit code, mutating calls, workspace\n${result.stderr}`).toEqual([1, [], []]);
    expect.soft(result.trace.filter((ev) => ev.op === "stdout.done").map((ev) => ev.code), "the write to the closed pipe failed").toEqual(["EPIPE"]);
    expect.soft(result.stderr, "the reason is reported").toContain("nothing was created");
  });

  it("lead_reserved_state_file_collision_stops_install", async () => {
    const points = [
      ["objects", "mkdirSync"], ["manifest.tmp", "openSync"], ["manifest.json", "linkSync"],
      ["objects/00", "openSync"], ["directories.json", "openSync"], ["complete", "openSync"],
    ];
    for (const host of ["claude", "codex"] as Host[]) for (const [name, op] of points) {
      const { w } = workspace();
      const rel = `.orch-lead-install/${name}`;
      const s = lead(["install", "--workspace", w, "--host", host], [
        { op, match: rel, action: "block", name: "RESERVED" },
      ]);
      expect(await s.phase("RESERVED"), `${host}/${name}: reached the reserved creation`).toBe(true);
      writeFileSync(at(w, rel), "foreign reserved file\n", { flag: "wx" });
      const foreign = [idOf(at(w, rel)), hashOf(at(w, rel))];
      const before = tree(w);
      s.release();
      s.child.stdin!.end();
      const r = await s.done;
      const word = ["objects", "manifest.tmp", "manifest.json"].includes(name) ? "UNVERIFIABLE_PREPARATION" : "PARTIAL";
      expect.soft([r.code, resultOf(r.stdout), /^stopped at: .+ \(it already exists and was left unchanged\)$/m.test(r.stdout)],
        `[reserved-file-stops] ${host}/${name}: collision stops install\n${r.stdout}${r.stderr}`).toEqual([2, word, true]);
      expect.soft([idOf(at(w, rel)), hashOf(at(w, rel)), tree(w)],
        `[reserved-file-stops] ${host}/${name}: foreign file preserved; nothing later created`).toEqual([...foreign, before]);
    }
  });

  it("lead_reserved_collision_status_depends_on_manifest", async () => {
    for (const host of ["claude", "codex"] as Host[]) for (const name of ["manifest.tmp", "objects/00"]) {
      const { w } = workspace();
      const rel = `.orch-lead-install/${name}`;
      const args = ["--workspace", w, "--host", host];
      const s = lead(["install", ...args], [{ op: "openSync", match: rel, action: "block", name: "COLLISION" }]);
      expect(await s.phase("COLLISION"), `${host}/${name}: reached creation`).toBe(true);
      writeFileSync(at(w, rel), "foreign file\n", { flag: "wx" });
      s.release();
      s.child.stdin!.end();
      const install = await s.done;
      const before = tree(w);
      const manifestPresent = existsSync(at(w, ".orch-lead-install/manifest.json"));
      const status = await run(["status", ...args]);
      const word = name === "manifest.tmp" ? "UNVERIFIABLE_PREPARATION" : "PARTIAL";
      expect.soft([install.code, resultOf(install.stdout), manifestPresent, status.code, resultOf(status.stdout), tree(w)],
        `[collision-status-by-manifest] ${host}/${name}: status reads the collision residue\n${status.stdout}`)
        .toEqual([2, word, name !== "manifest.tmp", 2, word, before]);
      expect.soft(dests(host).filter((dest) => existsSync(at(w, dest))), "[collision-status-by-manifest] no payload was published").toEqual([]);
    }
  });

  it("lead_unknown_state_name_does_not_stop_install", async () => {
    for (const host of ["claude", "codex"] as Host[]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      const rel = ".orch-lead-install/foreign";
      const s = lead(["install", ...args], [
        { op: "mkdirSync", when: "after", match: ".orch-lead-install/objects", action: "block", name: "UNKNOWN" },
      ]);
      expect(await s.phase("UNKNOWN"), `${host}: state directories created`).toBe(true);
      writeFileSync(at(w, rel), "unknown entry\n", { flag: "wx" });
      const foreign = [idOf(at(w, rel)), hashOf(at(w, rel))];
      s.release();
      s.child.stdin!.end();
      const install = await s.done;
      const before = tree(w);
      const status = await run(["status", ...args]);
      expect.soft([install.code, resultOf(install.stdout), install.stdout.includes("files created: 20 of 20"),
        /^stopped at:/m.test(install.stdout), existsSync(at(w, ".orch-lead-install/complete"))],
        `[unknown-name-continues] ${host}: install finishes publication\n${install.stdout}`).toEqual([2, "PARTIAL", true, false, true]);
      expect.soft([status.code, resultOf(status.stdout), status.stdout.includes(`unknown entry, not opened: ${at(w, rel)}`),
        dests(host).map((dest) => rowStates(status.stdout, w)[dest]), idOf(at(w, rel)), hashOf(at(w, rel)), tree(w)],
        `[unknown-name-continues] ${host}: status lists the unknown file and reads all payloads\n${status.stdout}`)
        .toEqual([2, "PARTIAL", true, dests(host).map(() => "OWNED_MATCH"), ...foreign, before]);
    }
  });

  it("lead_stopped_install_uninstall_can_retain_state_files", async () => {
    for (const host of ["claude", "codex"] as Host[]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      const rel = ".orch-lead-install/manifest.tmp";
      const s = lead(["install", ...args], [{ op: "openSync", match: rel, action: "block", name: "TMP" }]);
      expect(await s.phase("TMP"), `${host}: temporary manifest not yet created`).toBe(true);
      writeFileSync(at(w, rel), "foreign temporary file\n", { flag: "wx" });
      const identity = idOf(at(w, rel));
      s.release();
      s.child.stdin!.end();
      const install = await s.done;
      const retained = ["dir .orch-lead-install", `file ${rel} ${sha("foreign temporary file\n")}`, "dir .orch-lead-install/objects"];
      expect.soft([install.code, resultOf(install.stdout), tree(w), install.stdout.includes(FROZEN.cli_text.afterStop.text)],
        `[stopped-state-files-retained] ${host}: this run's state directories remain after the stop`)
        .toEqual([2, "UNVERIFIABLE_PREPARATION", retained, true]);
      const uninstall = await run(["uninstall", ...args]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout), tree(w), idOf(at(w, rel)), describeMutations(uninstall)],
        `[stopped-state-files-retained] ${host}: uninstall leaves the file for inspection\n${uninstall.stdout}`)
        .toEqual([2, "UNVERIFIABLE_PREPARATION", retained, identity, []]);
      expect.soft(uninstall.stdout, "[stopped-state-files-retained] the state directory to inspect is listed").toContain(at(w, ".orch-lead-install"));
    }
  });

  it("lead_late_ordinary_parent_is_used", async () => {
    for (const host of ["claude", "codex"] as const) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      const parent = PARENTS[host][0];
      const s = lead(["install", ...args], [{ op: "mkdirSync", when: "before", match: parent, action: "block", name: "BEFORE_PARENT" }]);
      expect(await s.phase("BEFORE_PARENT"), `${host}: reached the parent mkdir barrier`).toBe(true);
      mkdirSync(at(w, parent));
      const identity = idOf(at(w, parent));
      s.release();
      s.child.stdin!.end();
      const r = await s.done;
      expect.soft([r.code, resultOf(r.stdout)], `[late-parent-used] ${host}: install uses the late ordinary parent`).toEqual([0, "INSTALLED"]);
      expect.soft(idOf(at(w, parent)), `[late-parent-used] ${host}: parent identity is unchanged`).toBe(identity);
      expect.soft(dests(host).filter((dest) => existsSync(at(w, dest))),
        `[late-parent-used] ${host}: all 20 destinations exist`).toEqual(dests(host));
      const status = await run(["status", ...args]);
      expect.soft([status.code, resultOf(status.stdout)], `[late-parent-used] ${host}: status confirms the install`).toEqual([0, "INSTALLED"]);
      const uninstall = await run(["uninstall", ...args]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout), idOf(at(w, parent))],
        `[late-parent-used] ${host}: uninstall leaves the adopted parent`).toEqual([0, "NOT_INSTALLED", identity]);
      expect.soft(uninstall.stdout, `[late-parent-used] ${host}: parent is listed as left because install did not create it`)
        .toContain(`dir left        ${at(w, parent)}  (install did not create it)`);
    }
  });

  it("lead_second_process_wins_late_destination", async () => {
    const late = `${ROOT_OF.claude}/workflows/memory.md`;
    for (const kind of ["other bytes", "identical bytes"] as const) {
      const { w } = workspace();
      expect(tree(w), "clean setup").toEqual([]);
      const bytes = kind === "identical bytes" ? reviewedBytes("claude", late) : Buffer.from("written by the second process\n");
      const s = lead(["install", "--workspace", w, "--host", "claude"], [{ op: "linkSync", when: "before", match: late, action: "block", name: "BEFORE_LATE" }]);
      expect(await s.phase("BEFORE_LATE"), `${kind}: the installer reached the barrier`).toBe(true);
      expect.soft(existsSync(at(w, `${ROOT_OF.claude}/SKILL.md`)) && !existsSync(at(w, late)), `${kind}: the first publication happened, the late one did not`).toBe(true);
      // A real second process creates the late destination with an exclusive open.
      const second = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs");
        const fd = fs.openSync(process.argv[1], "wx");
        fs.writeSync(fd, Buffer.from(process.argv[2], "base64"));
        fs.closeSync(fd);
        process.stdout.write("READY\\n");
      `, at(w, late), bytes.toString("base64")], { encoding: "utf8", timeout: 15_000 });
      expect([second.status, second.stdout], `${kind}: the second process created the file and exited\n${second.stderr}`).toEqual([0, "READY\n"]);
      const foreign = [idOf(at(w, late)), hashOf(at(w, late))];
      s.release();
      s.child.stdin!.end();
      const r = await s.done;
      expect.soft([r.code, resultOf(r.stdout), r.stdout.includes(`stopped at: ${at(w, late)} `)], `[stops-at-collision] ${kind}: exit 2, PARTIAL, the path is named\n${r.stdout}\n${r.stderr}`).toEqual([2, "PARTIAL", true]);
      expect.soft([idOf(at(w, late)), hashOf(at(w, late))], `[late-file-preserved] ${kind}: the second process's file is the same file with the same bytes`).toEqual(foreign);
      const order = dests("claude");
      const laterRows = order.slice(order.indexOf(late) + 1);
      expect.soft(laterRows.filter((dest) => existsSync(at(w, dest))), `[stops-at-collision] ${kind}: no later payload was created`).toEqual([]);
      const earlierRows = order.slice(0, order.indexOf(late));
      expect.soft(earlierRows.filter((dest) => !existsSync(at(w, dest))), `[no-rollback] ${kind}: files created before the stop are still there`).toEqual([]);

      const status = await run(["status", "--workspace", w, "--host", "claude"]);
      const states = rowStates(status.stdout, w);
      expect.soft([status.code, resultOf(status.stdout), states[late]], `${kind}: status after the collision\n${status.stdout}`).toEqual([2, "PARTIAL", "FOREIGN"]);
      const uninstall = await run(["uninstall", "--workspace", w, "--host", "claude"]);
      expect.soft(uninstall.code, `${kind}: uninstall reports the residue\n${uninstall.stdout}`).toBe(2);
      expect.soft([idOf(at(w, late)), hashOf(at(w, late))], `[foreign-preserved-by-uninstall] ${kind}: uninstall leaves the second process's file alone`).toEqual(foreign);
      expect.soft(earlierRows.filter((dest) => existsSync(at(w, dest))), `[collision-cleanable] ${kind}: uninstall removed the files install created`).toEqual([]);
      expect.soft(uninstall.stdout, `${kind}: the preserved path is listed`).toContain(`preserved       ${at(w, late)}  (FOREIGN`);
    }
  });

  it("lead_sigkill_between_publications_is_visible_and_cleanable", async () => {
    const { w } = workspace();
    writeFileSync(join(w, "notes.txt"), "the user's own notes\n");
    const order = dests("claude");
    const first = order[0];
    const second = order[1];
    const s = lead(["install", "--workspace", w, "--host", "claude"], [{ op: "linkSync", when: "before", match: second, action: "block", name: "BETWEEN_PUBLICATIONS" }]);
    expect(await s.phase("BETWEEN_PUBLICATIONS"), "[phase-reached] the installer stopped between publication 1 and 2").toBe(true);
    s.kill();
    const killed = await s.done;
    console.log(`[observation] ${process.platform}: abrupt termination by child.kill("SIGKILL"): exit code ${killed.code}, signal ${killed.signal}`);
    expect([killed.code, killed.signal], "the process was killed, it did not exit by itself").toEqual(WINDOWS ? [1, null] : [null, "SIGKILL"]);
    expect.soft(killed.stdout, "the killed process never reported a result").not.toMatch(/^result:/m);

    // No cleanup ran: the manifest, all 20 anchors, the record of the directories and exactly the first payload are on disk.
    expect.soft(readFileSync(at(w, ".orch-lead-install/manifest.json"), "utf8"), "[kill-visible] the manifest is complete and names the killed installer").toBe(manifestText("claude", w, s.child.pid!));
    expect.soft(order.map((dest) => existsSync(at(w, dest))), "[kill-visible] exactly the first payload exists").toEqual(order.map((dest) => dest === first));
    expect.soft(order.map((dest) => hashOf(at(w, anchorOf("claude", dest)))), "[kill-visible] every anchor is complete").toEqual(order.map((dest) => FROZEN.sources[sourceOf("claude", dest)]));
    expect.soft(existsSync(at(w, ".orch-lead-install/manifest.tmp")), "no temporary manifest is left").toBe(false);

    const status = await run(["status", "--workspace", w, "--host", "claude"]);
    expect.soft([status.code, resultOf(status.stdout)], `[kill-visible] status after the kill\n${status.stdout}`).toEqual([2, "PARTIAL"]);
    expect.soft(rowStates(status.stdout, w), "[kill-visible] status names the one owned file and the 19 missing ones")
      .toEqual(Object.fromEntries(order.map((dest) => [dest, dest === first ? "OWNED_MATCH" : "MISSING"])));

    const uninstall = await run(["uninstall", "--workspace", w, "--host", "claude"]);
    expect.soft([uninstall.code, resultOf(uninstall.stdout)], `[kill-cleanable] uninstall after the kill\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
    expect.soft(tree(w), "[kill-cleanable] only the user's file is left: the directories the killed run created are gone too").toEqual([`file notes.txt ${sha("the user's own notes\n")}`]);
    expect.soft(status.stdout + uninstall.stdout, "nothing ever reported a complete install").not.toContain("INSTALLED\n".replace("INSTALLED", "result: INSTALLED"));
  });

  it("lead_kill_during_preparation_reports_retained_state", async () => {
    // (a) Killed while the temporary manifest is half written.
    {
      const { w } = workspace();
      const s = lead(["install", "--workspace", w, "--host", "claude"], [
        { op: "writeSync", when: "short", match: ".orch-lead-install/manifest.tmp", bytes: 20 },
        { op: "writeSync", when: "before", match: ".orch-lead-install/manifest.tmp", nth: 2, action: "block", name: "IN_MANIFEST" },
      ]);
      expect(await s.phase("IN_MANIFEST"), "[phase-reached] stopped inside the manifest write").toBe(true);
      s.kill();
      await s.done;
      const residue = tree(w);
      expect.soft(residue, "[no-payload-after-preparation-kill] only the reserved directory with 20 bytes of manifest").toEqual([
        "dir .orch-lead-install", `file .orch-lead-install/manifest.tmp ${sha(manifestText("claude", w, s.child.pid!).slice(0, 20))}`, "dir .orch-lead-install/objects",
      ]);
      const status = await run(["status", "--workspace", w, "--host", "claude"]);
      expect.soft([status.code, resultOf(status.stdout)], `[preparation-reported] status\n${status.stdout}`).toEqual([2, "UNVERIFIABLE_PREPARATION"]);
      const uninstall = await run(["uninstall", "--workspace", w, "--host", "claude"]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout), describeMutations(uninstall)], `[preparation-residue-retained] uninstall removes nothing\n${uninstall.stdout}`).toEqual([2, "UNVERIFIABLE_PREPARATION", []]);
      expect.soft(tree(w), "[preparation-residue-retained] the residue is still there, byte for byte").toEqual(residue);
      expect.soft(uninstall.stdout, "the directory to look at is named").toContain(at(w, ".orch-lead-install"));
    }
    // (b) Killed while an anchor is half written. This shows what is retained and reported; it
    // does not show, and nothing here claims, that every interrupted byte is removed.
    {
      const { w } = workspace();
      const partial = ".orch-lead-install/objects/05";
      const s = lead(["install", "--workspace", w, "--host", "claude"], [
        { op: "writeSync", when: "short", match: partial, bytes: 7 },
        { op: "writeSync", when: "before", match: partial, nth: 2, action: "block", name: "IN_ANCHOR" },
      ]);
      expect(await s.phase("IN_ANCHOR"), "[phase-reached] stopped inside an anchor write").toBe(true);
      s.kill();
      await s.done;
      const partialBytes = readFileSync(at(w, partial));
      expect.soft(partialBytes.length, "the anchor holds 7 of its bytes").toBe(7);
      expect.soft(dests("claude").filter((dest) => existsSync(at(w, dest))), "[no-payload-after-preparation-kill] no payload was published").toEqual([]);
      const status = await run(["status", "--workspace", w, "--host", "claude"]);
      expect.soft([status.code, resultOf(status.stdout), status.stdout.includes(`anchor without the reviewed text: ${at(w, partial)}`)], `[preparation-reported] status names the partial anchor\n${status.stdout}`).toEqual([2, "PARTIAL", true]);
      const uninstall = await run(["uninstall", "--workspace", w, "--host", "claude"]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], `uninstall reports residue\n${uninstall.stdout}`).toEqual([2, "PARTIAL"]);
      expect.soft(tree(w), "[partial-anchor-retained] the partial anchor and the manifest stay; complete anchors are gone").toEqual([
        "dir .orch-lead-install", `file .orch-lead-install/manifest.json ${sha(manifestText("claude", w, s.child.pid!))}`,
        "dir .orch-lead-install/objects", `file ${partial} ${sha(partialBytes)}`,
      ]);
      expect.soft(uninstall.stdout, "the retained anchor is listed").toContain(`state preserved ${at(w, partial)}`);
    }
  });

  it("lead_uninstall_retry_after_kill_is_idempotent", async () => {
    const points: { name: string; rule: Rule }[] = [
      { name: "after the first unlink", rule: { op: "unlinkSync", when: "after", nth: 1, action: "block", name: "KILL_HERE" } },
      { name: "after the payload files", rule: { op: "unlinkSync", when: "before", match: ".orch-lead-install/objects/00", action: "block", name: "KILL_HERE" } },
      { name: "after one anchor", rule: { op: "unlinkSync", when: "after", match: ".orch-lead-install/objects/00", action: "block", name: "KILL_HERE" } },
      { name: "before the manifest", rule: { op: "unlinkSync", when: "before", match: ".orch-lead-install/manifest.json", action: "block", name: "KILL_HERE" } },
    ];
    const args = (w: string) => ["--workspace", w, "--host", "claude"];
    const lines = (stdout: string, w: string, word: string) => stdout.split("\n").filter((line) => line.startsWith(`  ${word}`)).map((line) => line.slice(18).replace(/ {2}\(.*$/, "").slice(w.length + 1).split(sep).join("/"));
    for (const point of points) {
      const { w } = workspace();
      expect((await run(["install", ...args(w)])).code, `${point.name}: install`).toBe(0);
      const s = lead(["uninstall", ...args(w)], [point.rule]);
      expect(await s.phase("KILL_HERE"), `[phase-reached] ${point.name}`).toBe(true);
      s.kill();
      await s.done;
      const goneBefore = dests("claude").filter((dest) => !existsSync(at(w, dest)));
      const retry = await run(["uninstall", ...args(w)]);
      expect.soft([retry.code, resultOf(retry.stdout)], `[retry-completes] ${point.name}: the retry finishes\n${retry.stdout}\n${retry.stderr}`).toEqual([0, "NOT_INSTALLED"]);
      expect.soft(tree(w), `[retry-completes] ${point.name}: nothing is left`).toEqual([]);
      expect.soft(lines(retry.stdout, w, "already absent ").sort(), `[all-paths-accounted] ${point.name}: paths removed by the killed run are reported as already absent`).toEqual([...goneBefore].sort());
      expect.soft([...lines(retry.stdout, w, "already absent "), ...lines(retry.stdout, w, "removed        ")].sort(), `[all-paths-accounted] ${point.name}: all 20 paths are accounted for`).toEqual([...dests("claude")].sort());
    }
    // With an edited file: the retry keeps it, with its anchor and the manifest, and says so.
    const { w } = workspace();
    expect((await run(["install", ...args(w)])).code).toBe(0);
    const edited = `${ROOT_OF.claude}/brief.md`;
    appendFileSync(at(w, edited), "my own line\n");
    const editedBytes = readFileSync(at(w, edited));
    const s = lead(["uninstall", ...args(w)], [points[0].rule]);
    expect(await s.phase("KILL_HERE")).toBe(true);
    s.kill();
    await s.done;
    const retry = await run(["uninstall", ...args(w)]);
    expect.soft([retry.code, resultOf(retry.stdout)], `[retry-retains-mismatch] the retry reports residue\n${retry.stdout}`).toEqual([2, "PARTIAL"]);
    expect.soft(tree(w).filter((line) => line.startsWith("file ")), "[retry-retains-mismatch] the edited file, its anchor, the manifest and the two records stay").toEqual([
      `file ${edited} ${sha(editedBytes)}`, ...["complete", "directories.json", "manifest.json"].map((name) => `file .orch-lead-install/${name} ${hashOf(at(w, `.orch-lead-install/${name}`))}`),
      `file ${anchorOf("claude", edited)} ${sha(editedBytes)}`,
    ].sort());
    expect.soft(tree(w).filter((line) => line.startsWith("dir ") && !line.includes(".orch-lead-install")), "[retry-retains-mismatch] and no directory was removed while a file is preserved")
      .toEqual(createdDirs("claude").map((dir) => `dir ${dir}`));
    expect.soft([...lines(retry.stdout, w, "already absent "), ...lines(retry.stdout, w, "removed        "), ...lines(retry.stdout, w, "preserved      ")].sort(), "[all-paths-accounted] with an edited file").toEqual([...dests("claude")].sort());
  });

  it("lead_corrupt_manifest_never_opens_outside", async () => {
    const good = (w: string) => dests("claude").map((dest, i) => ({ path: dest, sha256: FROZEN.sources[sourceOf("claude", dest)] as string, anchor: `objects/${String(i).padStart(2, "0")}` }));
    const withRow = (w: string, index: number, change: Record<string, string>) => good(w).map((row, i) => (i === index ? { ...row, ...change } : row));
    const pid = deadPid();
    const cases: { name: string; manifest(w: string, outside: string): string | { linkTo: string } }[] = [
      { name: "a row path that climbs out", manifest: (w) => manifestText("claude", w, pid, withRow(w, 3, { path: "../outside/secret.txt" })) },
      { name: "an absolute row path", manifest: (w, outside) => manifestText("claude", w, pid, withRow(w, 3, { path: join(outside, "secret.txt") })) },
      { name: "a row path with backslashes", manifest: (w) => manifestText("claude", w, pid, withRow(w, 3, { path: "..\\outside\\secret.txt" })) },
      { name: "an anchor that climbs out", manifest: (w) => manifestText("claude", w, pid, withRow(w, 3, { anchor: "../../outside/secret.txt" })) },
      { name: "a repeated row", manifest: (w) => manifestText("claude", w, pid, good(w).map((row, i, all) => (i === 4 ? all[3] : row))) },
      { name: "another host", manifest: (w) => manifestText("codex", w, pid) },
      { name: "another workspace", manifest: (w, outside) => manifestText("claude", outside, pid) },
      { name: "another hash", manifest: (w) => manifestText("claude", w, pid, withRow(w, 3, { sha256: "0".repeat(64) })) },
      { name: "more than 64 KiB", manifest: (w) => manifestText("claude", w, pid).replace("\n]}\n", `\n]}${" ".repeat(70_000)}\n`) },
      { name: "another schema", manifest: (w) => manifestText("claude", w, pid).replace('"schema":1', '"schema":2') },
      { name: "a completion flag", manifest: (w) => manifestText("claude", w, pid).replace('"schema":1', '"schema":1,"complete":true') },
      { name: "a repeated key", manifest: (w) => manifestText("claude", w, pid).replace('"schema":1', '"schema":1,"schema":1') },
      { name: "not JSON", manifest: () => "{" },
      { name: "a manifest that is a link to a valid one outside", manifest: (w, outside) => {
        writeFileSync(join(outside, "manifest.json"), manifestText("claude", w, pid));
        return { linkTo: join(outside, "manifest.json") };
      } },
    ];
    for (const c of cases) {
      const { base, w } = workspace();
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "not part of the workspace\n");
      mkdirSync(at(w, ".orch-lead-install/objects"), { recursive: true });
      writeFileSync(at(w, ".orch-lead-install/notes-from-someone"), "unknown entry\n");
      writeFileSync(at(w, "CLAUDE.md"), "the user's file\n");
      const m = c.manifest(w, outside);
      if (typeof m === "string") writeFileSync(at(w, ".orch-lead-install/manifest.json"), m);
      else symlinkSync(m.linkTo, at(w, ".orch-lead-install/manifest.json"));
      const before = [tree(w), tree(outside)];
      const outsidePrefix = outside.split(sep).join("/");
      for (const command of ["status", "uninstall"]) {
        const r = await run([command, "--workspace", w, "--host", "claude"]);
        expect.soft([r.code, resultOf(r.stdout)], `[corrupt-manifest-refused] ${c.name}: ${command}\n${r.stdout}\n${r.stderr}`).toEqual([2, "UNVERIFIABLE_PREPARATION"]);
        expect.soft(r.trace.filter((ev) => [ev.path, ev.path2].some((p) => typeof p === "string" && p.startsWith(outsidePrefix))).map((ev) => `${ev.op} ${ev.path}`),
          `[no-outside-access] ${c.name}: ${command} touches nothing outside the workspace`).toEqual([]);
        expect.soft(r.trace.filter((ev) => ev.op === "openSync" && ev.path.endsWith("notes-from-someone")).length, `[unknown-not-opened] ${c.name}: ${command} does not open the unknown entry`).toBe(0);
        expect.soft([describeMutations(r), r.trace.filter((ev) => ev.op === "process").length], `[corrupt-no-mutation] ${c.name}: ${command} makes no mutating call and starts nothing`).toEqual([[], 0]);
      }
      expect.soft([tree(w), tree(outside)], `[corrupt-no-mutation] ${c.name}: everything is retained, including the unknown entry`).toEqual(before);
    }
  });

  it("lead_concurrent_install_reservation_and_busy_cleanup", async () => {
    const { w } = workspace();
    const args = ["--workspace", w, "--host", "claude"];
    const reserve: Rule = { op: "mkdirSync", when: "before", match: ".orch-lead-install", action: "block", name: "BEFORE_RESERVE" };
    const a = lead(["install", ...args], [reserve, { op: "linkSync", when: "before", match: dests("claude")[1], action: "block", name: "A_HELD" }]);
    const b = lead(["install", ...args], [reserve]);
    expect([await a.phase("BEFORE_RESERVE"), await b.phase("BEFORE_RESERVE")], "both installers passed the check and stand before the reservation").toEqual([true, true]);
    a.release();
    expect(await a.phase("A_HELD"), "A reserved the workspace and is held, alive, after its first publication").toBe(true);
    b.release();
    b.child.stdin!.end();
    const loser = await b.done;
    expect.soft([loser.code, resultOf(loser.stdout)], `[no-adoption] the second installer refuses\n${loser.stdout}\n${loser.stderr}`).toEqual([2, "CONFLICT"]);
    expect.soft(mutations(loser).map((ev) => `${ev.op} ${ev.code}`), "[no-adoption] its only mutating call is the refused reservation").toEqual(["mkdirSync EEXIST"]);
    expect.soft(readFileSync(at(w, ".orch-lead-install/manifest.json"), "utf8"), "[no-adoption] the manifest is the winner's").toBe(manifestText("claude", w, a.child.pid!));

    // A is alive: uninstall and status say BUSY, change nothing, and only ask about the process.
    const before = tree(w);
    const uninstall = await run(["uninstall", ...args]);
    expect.soft([uninstall.code, resultOf(uninstall.stdout), describeMutations(uninstall)], `[busy-refuses] uninstall while the installer lives\n${uninstall.stdout}`).toEqual([2, "BUSY", []]);
    expect.soft(uninstall.trace.filter((ev) => ev.op === "kill").map((ev) => [ev.pid, ev.signal]), "[liveness-query-only] the only signal call is the question (signal 0) about the installer").toEqual([[a.child.pid, 0]]);
    expect.soft([a.child.exitCode, a.child.signalCode, tree(w)], "[busy-refuses] the installer is still running and nothing changed").toEqual([null, null, before]);
    const status = await run(["status", ...args]);
    expect.soft([status.code, resultOf(status.stdout)], "[status-busy] status while the installer lives").toEqual([2, "BUSY"]);
    a.release();
    a.child.stdin!.end();
    const winner = await a.done;
    expect.soft([winner.code, resultOf(winner.stdout)], `the winner completes\n${winner.stdout}\n${winner.stderr}`).toEqual([0, "INSTALLED"]);

    // The install is recorded as finished now. Whatever the recorded id would answer (alive, not
    // ours to ask, an unknown error), status does not ask and reports INSTALLED.
    const installed = tree(w);
    const probes: [string, (pid: number) => void][] = [
      ["a live process has the id", () => {}],
      ["asking is not permitted", () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }],
      ["the answer is an unknown error", () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }],
    ];
    for (const [name, probe] of probes) {
      let out = "";
      const asked: number[] = [];
      const exit = await main(["lead", "status", ...args], { out: (s) => (out += s), err: () => {}, stdin: () => "" },
        { lead: { probe: (pid: number) => { asked.push(pid); probe(pid); } } } as never);
      expect.soft([exit, resultOf(out), asked, tree(w)], `[finished-not-asked] ${name}`).toEqual([0, "INSTALLED", [], installed]);
    }
    const finish = await run(["uninstall", ...args]);
    expect.soft([finish.code, resultOf(finish.stdout), tree(w)], "uninstall of the finished install leaves nothing").toEqual([0, "NOT_INSTALLED", []]);
  });
});

describe.skipIf(!RUN)("orch lead: reinstall, own directories, finished installs", () => {
  const H = ROOT_OF.claude;
  const slash = (path: string) => path.split(sep).join("/");
  /** A traced path relative to the workspace, or marked as outside it. */
  const relOf = (w: string, path: string) => (path.startsWith(`${slash(w)}/`) ? path.slice(slash(w).length + 1) : `OUTSIDE ${path}`);
  /** Directories uninstall says it left, with the reason it prints. */
  const left = (stdout: string, w: string): Record<string, string> => Object.fromEntries(stdout.split("\n")
    .map((line) => /^ {2}dir left {8}(.+?) {2}\((.+)\)$/.exec(line)).filter((m) => m !== null).map((m) => [relOf(w, slash(m![1])), m![2]]));
  const rmdirs = (r: Result, w: string, ok: boolean) => r.trace.filter((ev) => ev.op === "rmdirSync" && (ev.code === "OK") === ok).map((ev) => relOf(w, ev.path));
  const STATE_DIRS = [".orch-lead-install", ".orch-lead-install/objects"];

  it("lead_uninstall_removes_accepted_records_and_fixed_paths", async () => {
    for (const host of ["claude", "codex"] as Host[]) {
      const { base, w } = workspace();
      const args = ["--workspace", w, "--host", host];
      mkdirSync(at(w, "unrelated-empty"));
      expect((await run(["install", ...args])).code, `${host}: install`).toBe(0);
      const records = ["manifest.json", "directories.json", "complete"];
      const manifest = readFileSync(at(w, ".orch-lead-install/manifest.json"));
      expect(manifest.toString(), "accepted manifest bytes").toBe(manifestText(host, w, JSON.parse(manifest.toString()).pid));
      expect(readFileSync(at(w, ".orch-lead-install/complete"), "utf8"), "accepted completion bytes")
        .toBe(`{"schema":1,"manifest":"${sha(manifest)}","install":"complete"}\n`);
      for (const name of records) {
        const path = at(w, `.orch-lead-install/${name}`);
        const bytes = readFileSync(path);
        const identity = idOf(path);
        renameSync(path, join(base, name));
        writeFileSync(path, bytes, { flag: "wx" });
        expect(idOf(path), `${name}: replacement has a different identity`).not.toBe(identity);
      }
      linkSync(at(w, ".orch-lead-install/manifest.json"), at(w, ".orch-lead-install/manifest.tmp"));
      const uninstall = await run(["uninstall", ...args]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout), tree(w)],
        `[accepted-records-fixed-paths] ${host}: payloads, anchors, accepted records and fixed empty directories go\n${uninstall.stdout}`)
        .toEqual([0, "NOT_INSTALLED", ["dir unrelated-empty"]]);
      const removedFiles = dests(host).map((dest) => `  removed         ${at(w, dest)}`);
      const removedState = [...dests(host).map((dest) => anchorOf(host, dest)), ...records.map((name) => `.orch-lead-install/${name}`),
        ".orch-lead-install/manifest.tmp", ".orch-lead-install/objects", ".orch-lead-install"].map((rel) => `  state removed   ${at(w, rel)}`);
      expect.soft([...removedFiles, ...removedState].filter((line) => !uninstall.stdout.includes(line)),
        "[accepted-records-fixed-paths] every removed payload, anchor and state path is listed").toEqual([]);
      expect.soft(createdDirs(host).filter((rel) => !uninstall.stdout.includes(`  dir removed     ${at(w, rel)}`)),
        "[accepted-records-fixed-paths] removal is limited to the fixed host and state layout").toEqual([]);
    }
  });

  it("lead_recreated_state_directories_removed_only_when_cleanup_finishes", async () => {
    for (const host of ["claude", "codex"] as Host[]) for (const name of [".orch-lead-install", ".orch-lead-install/objects"]) {
      const { base, w } = workspace();
      const args = ["--workspace", w, "--host", host];
      expect((await run(["install", ...args])).code, `${host}: install`).toBe(0);
      const path = at(w, name);
      const original = idOf(path);
      const parked = join(base, "parked");
      renameSync(path, parked);
      mkdirSync(path);
      for (const entry of readdirSync(parked)) renameSync(join(parked, entry), join(path, entry));
      const replacement = idOf(path);
      expect(replacement, `${host}/${name}: recreated by another actor`).not.toBe(original);
      const status = await run(["status", ...args]);
      expect([status.code, resultOf(status.stdout)], "accepted manifest and records").toEqual([0, "INSTALLED"]);
      const unknown = at(w, ".orch-lead-install/foreign");
      writeFileSync(unknown, "block cleanup\n");
      const blocked = await run(["uninstall", ...args]);
      expect.soft([blocked.code, resultOf(blocked.stdout), idOf(path), existsSync(at(w, ".orch-lead-install/manifest.json"))],
        `[recreated-state-cleanup-gated] ${host}/${name}: residue blocks state-directory removal`).toEqual([2, "PARTIAL", replacement, true]);
      unlinkSync(unknown);
      const finish = await run(["uninstall", ...args]);
      expect.soft([finish.code, resultOf(finish.stdout), tree(w), rmdirs(finish, w, true)],
        `[recreated-state-cleanup-gated] ${host}/${name}: clean finish removes both state directories by name\n${finish.stdout}`)
        .toEqual([0, "NOT_INSTALLED", [], [".orch-lead-install/objects", ".orch-lead-install"]]);
      const { w: empty } = workspace();
      mkdirSync(at(empty, ".orch-lead-install/objects"), { recursive: true });
      const residue = tree(empty);
      const noManifest = await run(["uninstall", "--workspace", empty, "--host", host]);
      expect.soft([noManifest.code, resultOf(noManifest.stdout), tree(empty), describeMutations(noManifest)],
        "[recreated-state-cleanup-gated] empty directories alone do not authorize cleanup").toEqual([2, "UNVERIFIABLE_PREPARATION", residue, []]);
    }
  });

  it("lead_help_cleanup_matches_recorded_directories_and_finish_gate", async () => {
    for (const host of ["claude", "codex"] as Host[]) for (const blocked of [false, true]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      mkdirSync(at(w, PARENTS[host][0]));
      expect((await run(["install", ...args])).code, `${host}: install`).toBe(0);
      const records = ["manifest.json", "directories.json", "complete"].map((name) => `.orch-lead-install/${name}`);
      const recorded = JSON.parse(readFileSync(at(w, ".orch-lead-install/directories.json"), "utf8")).created.map((row: { path: string }) => row.path);
      expect(recorded, "only the directories this install created are recorded").toEqual(createdDirs(host).slice(1));
      if (blocked) appendFileSync(at(w, BOOT[host]), "user edit\n");
      const recordBytes = records.map((rel) => hashOf(at(w, rel)));
      const uninstall = await run(["uninstall", ...args]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], "[help-cleanup-finish-gate] cleanup reports whether it could finish")
        .toEqual(blocked ? [2, "PARTIAL"] : [0, "NOT_INSTALLED"]);
      if (blocked) {
        expect.soft([records.map((rel) => hashOf(at(w, rel))), recorded.filter((rel: string) => !existsSync(at(w, rel))),
          existsSync(at(w, ".orch-lead-install/objects")), existsSync(at(w, BOOT[host])), existsSync(at(w, anchorOf(host, BOOT[host])))],
          "[help-cleanup-finish-gate] edited payload, anchor, records and directories remain when cleanup is blocked")
          .toEqual([recordBytes, [], true, true, true]);
        expect.soft(dests(host).filter((dest) => dest !== BOOT[host] && existsSync(at(w, dest))),
          "[help-cleanup-finish-gate] unchanged verified files are removed").toEqual([]);
      } else {
        expect.soft(tree(w), "[help-cleanup-finish-gate] verified files, anchors, accepted records and recorded empty directories go")
          .toEqual([`dir ${PARENTS[host][0]}`]);
        expect.soft(rmdirs(uninstall, w, true).sort(), "[help-cleanup-finish-gate] recorded host directories and both state directories are removed")
          .toEqual([...recorded, ".orch-lead-install/objects", ".orch-lead-install"].sort());
      }
    }
  });

  it("lead_reinstall_after_uninstall_round_trip", async () => {
    for (const host of ["claude", "codex"] as Host[]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      // Round 1 in an empty workspace. Before round 2 the user has notes of the kind the guides describe, and an ignore rule.
      let notes: string[] = [];
      for (const round of [1, 2]) {
        if (round === 2) {
          mkdirSync(at(w, "workspace-notes/personal/entries"), { recursive: true });
          writeFileSync(at(w, "workspace-notes/personal/INDEX.md"), "- [name](entries/name.md) | preference | active | a note of the user's\n");
          writeFileSync(at(w, "workspace-notes/personal/entries/name.md"), "the user's note\n");
          writeFileSync(at(w, ".ignore"), "/workspace-notes/personal/\n");
          notes = tree(w);
        }
        const install = await run(["install", ...args]);
        expect.soft([install.code, resultOf(install.stdout)], `[round-trip] ${host}, round ${round}: install succeeds\n${install.stdout}\n${install.stderr}`).toEqual([0, "INSTALLED"]);
        const status = await run(["status", ...args]);
        expect.soft([status.code, resultOf(status.stdout)], `[round-trip] ${host}, round ${round}: status\n${status.stdout}`).toEqual([0, "INSTALLED"]);
        const uninstall = await run(["uninstall", ...args]);
        expect.soft([uninstall.code, resultOf(uninstall.stdout)], `[round-trip] ${host}, round ${round}: uninstall completes\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
        expect.soft(tree(w), `[round-trip] ${host}, round ${round}: the workspace is as it was before install`).toEqual(notes);
        const onNotes = [install, status, uninstall].flatMap((r) => r.trace).filter((ev) => [ev.path, ev.path2].some((path) => typeof path === "string" && /^(workspace-notes(\/|$)|\.ignore$)/.test(relOf(w, path))));
        expect.soft([round === 1 || notes.length === 6, onNotes.map((ev) => `${ev.op} ${relOf(w, ev.path)}`)], `[notes-untouched] ${host}, round ${round}: no command makes any file call on the notes folder or the ignore file`).toEqual([true, []]);
        expect.soft(rmdirs(uninstall, w, true).sort(), `[own-directories-removed] ${host}, round ${round}: exactly the directories install created, and the two state directories`)
          .toEqual([...createdDirs(host), ...STATE_DIRS].sort());
        expect.soft(rmdirs(uninstall, w, false), `[deepest-first] ${host}, round ${round}: no removal was tried on a directory that still held something`).toEqual([]);
        expect.soft(createdDirs(host).filter((dir) => !uninstall.stdout.includes(`  dir removed     ${at(w, dir)}\n`)), `[own-directories-removed] ${host}, round ${round}: each one is listed as removed`).toEqual([]);
      }
    }
  });

  it("lead_uninstall_removes_only_its_own_empty_directories", async () => {
    const claude = (w: string) => ["--workspace", w, "--host", "claude"];
    // A file of the user's inside the pack directory keeps that directory and everything above it.
    {
      const { w } = workspace();
      expect((await run(["install", ...claude(w)])).code, "install").toBe(0);
      const mine = `${H}/workflows/my-own-guide.md`;
      writeFileSync(at(w, mine), "the user's own guide\n");
      const kept = [".claude", ".claude/skills", H, `${H}/workflows`];
      const ids = kept.map((dir) => idOf(at(w, dir)));
      const uninstall = await run(["uninstall", ...claude(w)]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], `the installed files and the state are gone\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
      expect.soft(tree(w), "[user-file-keeps-directory] the user's file, its directory and everything above it stay; the empty directory beside it is removed")
        .toEqual(["dir .claude", "dir .claude/skills", `dir ${H}`, `dir ${H}/workflows`, `file ${mine} ${sha("the user's own guide\n")}`]);
      expect.soft(kept.map((dir) => idOf(at(w, dir))), "[user-file-keeps-directory] and they are the same directories").toEqual(ids);
      expect.soft(left(uninstall.stdout, w), "[directory-left-reported] uninstall names each directory it left, with the reason").toEqual(Object.fromEntries(kept.map((dir) => [dir, "not empty"])));
      expect.soft(uninstall.stdout, "[directory-left-reported] and the one it removed").toContain(`  dir removed     ${at(w, `${H}/agents`)}\n`);
      const again = await run(["install", ...claude(w)]);
      expect.soft([again.code, resultOf(again.stdout), describeMutations(again)], "a new install is a conflict while the user's file is in the pack directory").toEqual([2, "CONFLICT", []]);
    }
    // A host parent that was there before install is there after uninstall.
    for (const [host, existing] of [["claude", [".claude"]], ["codex", [".agents", ".agents/skills"]]] as [Host, string[]][]) {
      const { w } = workspace();
      const args = ["--workspace", w, "--host", host];
      for (const dir of existing) mkdirSync(at(w, dir));
      const ids = existing.map((dir) => idOf(at(w, dir)));
      for (const round of [1, 2]) {
        const install = await run(["install", ...args]);
        expect.soft([install.code, resultOf(install.stdout)], `[preexisting-parent-kept] ${host}, round ${round}: install beside the directory that was already there\n${install.stdout}`).toEqual([0, "INSTALLED"]);
        const uninstall = await run(["uninstall", ...args]);
        expect.soft([uninstall.code, resultOf(uninstall.stdout)], `${host}, round ${round}: uninstall completes\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
        expect.soft([tree(w), existing.map((dir) => idOf(at(w, dir)))], `[preexisting-parent-kept] ${host}, round ${round}: what was there before install is all that is left, and it is the same directory`)
          .toEqual([existing.map((dir) => `dir ${dir}`), ids]);
        expect.soft(uninstall.trace.filter((ev) => ev.op === "rmdirSync").map((ev) => relOf(w, ev.path)).filter((dir) => existing.includes(dir)),
          `[preexisting-parent-kept] ${host}, round ${round}: no removal was even tried on it`).toEqual([]);
        expect.soft(left(uninstall.stdout, w), `[directory-left-reported] ${host}, round ${round}: and uninstall says why it stays`).toEqual(Object.fromEntries(existing.map((dir) => [dir, "install did not create it"])));
      }
    }
    // An empty directory the user made at the same path later is not the directory install created.
    {
      const { w } = workspace();
      expect((await run(["install", ...claude(w)])).code, "install").toBe(0);
      const agents = `${H}/agents`;
      mkdirSync(at(w, `${agents}.new`));
      for (const name of readdirSync(at(w, agents))) unlinkSync(join(at(w, agents), name));
      rmdirSync(at(w, agents));
      renameSync(at(w, `${agents}.new`), at(w, agents));
      const id = idOf(at(w, agents));
      const uninstall = await run(["uninstall", ...claude(w)]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], `uninstall completes\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED"]);
      expect.soft([idOf(at(w, agents)), tree(w)], "[recreated-directory-kept] the user's directory stays, with everything above it").toEqual([id, ["dir .claude", "dir .claude/skills", `dir ${H}`, `dir ${agents}`]]);
      expect.soft(left(uninstall.stdout, w), "[directory-left-reported] with the reasons")
        .toEqual({ [agents]: "not the directory install created", [H]: "not empty", ".claude/skills": "not empty", ".claude": "not empty" });
    }
    // A directory replaced by a link: nothing behind the link is opened, removed or even looked at.
    const LINKED = "a folder on its path is a link";
    const variants = [
      ["the pack directory", H, LINKED], ["a directory inside the pack", `${H}/agents`, LINKED], ["a host parent", ".claude/skills", LINKED],
      ["the directory of the anchors", ".orch-lead-install/objects", "its anchor cannot be read, so ownership is unknown"],
    ];
    for (const [name, target, why] of variants) {
      const { base, w } = workspace();
      expect((await run(["install", ...claude(w)])).code, "install").toBe(0);
      const outside = join(base, "moved away");
      renameSync(at(w, target), outside);
      writeFileSync(join(outside, "canary.txt"), "not part of the workspace\n");
      symlinkSync(outside, at(w, target), "dir");
      const behindBefore = tree(outside);
      // Every installed path below the link; with the anchors behind the link, every installed path.
      const through = dests("claude").filter((dest) => dest.startsWith(`${target}/`) || target.startsWith(".orch-lead-install/"));
      const behind = (r: Result) => r.trace.filter((ev) => [ev.path, ev.path2].some((p) => typeof p === "string" && (p.startsWith(`${slash(at(w, target))}/`) || p === slash(outside) || p.startsWith(`${slash(outside)}/`))))
        .map((ev) => `${ev.op} ${ev.path}`);
      const status = await run(["status", ...claude(w)]);
      expect.soft([status.code, resultOf(status.stdout), behind(status)], `[link-refused] ${name}: status reports it without reading behind the link\n${status.stdout}`).toEqual([2, "PARTIAL", []]);
      expect.soft(through.filter((dest) => rowStates(status.stdout, w)[dest] !== "UNVERIFIABLE"), `[link-refused] ${name}: every path through the link is UNVERIFIABLE`).toEqual([]);
      const uninstall = await run(["uninstall", ...claude(w)]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout)], `[link-refused] ${name}: uninstall reports residue\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([2, "PARTIAL"]);
      expect.soft(behind(uninstall), `[nothing-behind-link] ${name}: no file call of any kind (open, unlink, rmdir, lstat, readdir) reaches behind the link`).toEqual([]);
      expect.soft(uninstall.trace.filter((ev) => ev.op === "rmdirSync").map((ev) => relOf(w, ev.path)), `[nothing-behind-link] ${name}: no directory removal is tried`).toEqual([]);
      expect.soft(tree(outside), `[nothing-behind-link] ${name}: the canary and everything else behind the link are unchanged`).toEqual(behindBefore);
      expect.soft([lstatSync(at(w, target)).isSymbolicLink(), readlinkSync(at(w, target))], `[nothing-behind-link] ${name}: the link is still the link`).toEqual([true, outside]);
      expect.soft(through.filter((dest) => !uninstall.stdout.includes(`  preserved       ${at(w, dest)}  (UNVERIFIABLE: ${why})\n`)),
        `[link-refused] ${name}: every path through the link is listed as preserved`).toEqual([]);
      expect.soft([through.length > 0, existsSync(at(w, ".orch-lead-install/manifest.json")), through.filter((dest) => !existsSync(at(w, anchorOf("claude", dest))))],
        `[link-refused] ${name}: the record and the anchors of those paths stay`).toEqual([true, true, []]);
      // The user puts the folder back: uninstall then finishes.
      unlinkSync(at(w, target));
      unlinkSync(join(outside, "canary.txt"));
      renameSync(outside, at(w, target));
      const finish = await run(["uninstall", ...claude(w)]);
      expect.soft([finish.code, resultOf(finish.stdout), tree(w)], `[link-undone-cleans] ${name}: with the folder back in place uninstall leaves nothing\n${finish.stdout}\n${finish.stderr}`).toEqual([0, "NOT_INSTALLED", []]);
    }
    for (const state of ["no state", "invalid manifest"] as const) {
      for (const [name, target] of variants.slice(0, 3)) {
        const { base, w } = workspace();
        expect((await run(["install", ...claude(w)])).code, "install").toBe(0);
        const outside = join(base, `moved away ${state}`);
        renameSync(at(w, target), outside);
        writeFileSync(join(outside, "canary.txt"), "not part of the workspace\n");
        symlinkSync(outside, at(w, target), "dir");
        if (state === "no state") rmSync(at(w, ".orch-lead-install"), { recursive: true });
        else writeFileSync(at(w, ".orch-lead-install/manifest.json"), "{");
        const before = tree(outside);
        const through = dests("claude").filter((dest) => dest.startsWith(`${target}/`));
        const behind = (r: Result) => r.trace.filter((ev) => [ev.path, ev.path2].some((p) => typeof p === "string" && p.startsWith(`${slash(at(w, target))}/`)));
        for (const command of ["status", "uninstall"] as const) {
          const result = await run([command, ...claude(w)]);
          expect.soft(behind(result), `[nothing-behind-link-no-state] ${state}, ${name}, ${command}: no file call of any kind reaches behind the link`).toEqual([]);
          expect.soft(through.filter((dest) => rowStates(result.stdout, w)[dest] !== "UNVERIFIABLE"),
            `[nothing-behind-link-no-state] ${state}, ${name}, ${command}: every payload row below the link is UNVERIFIABLE`).toEqual([]);
          expect.soft(tree(outside), `[nothing-behind-link-no-state] ${state}, ${name}, ${command}: the canary behind the link is unchanged`).toEqual(before);
        }
      }
    }
  });

  it("lead_finished_install_is_never_busy", async () => {
    const claude = (w: string) => ["--workspace", w, "--host", "claude"];
    const questions = (r: Result) => r.trace.filter((ev) => ev.op === "kill").map((ev) => [ev.pid, ev.signal]);
    // (1) A complete install whose recorded process id is in use by a live process: here the
    // installer itself, held after all its work, before its process ends.
    {
      const { w } = workspace();
      const installer = lead(["install", ...claude(w)], [{ op: "exit", action: "block", name: "INSTALL_DONE" }]);
      expect(await installer.phase("INSTALL_DONE"), "[phase-reached] the installer did all its work and is held before its process ends").toBe(true);
      expect.soft(hashOf(at(w, ".orch-lead-install/manifest.json")), "the record names the live installer").toBe(sha(manifestText("claude", w, installer.child.pid!)));
      const status = await run(["status", ...claude(w)]);
      expect.soft([status.code, resultOf(status.stdout)], `[finished-not-busy] status of a finished install whose installer id is alive\n${status.stdout}`).toEqual([0, "INSTALLED"]);
      const uninstall = await run(["uninstall", ...claude(w)]);
      expect.soft([installer.child.exitCode, installer.child.signalCode], "the process with the recorded id is still alive").toEqual([null, null]);
      expect.soft([uninstall.code, resultOf(uninstall.stdout), tree(w)], `[finished-not-busy] uninstall proceeds and leaves nothing\n${uninstall.stdout}\n${uninstall.stderr}`).toEqual([0, "NOT_INSTALLED", []]);
      expect.soft([...questions(status), ...questions(uninstall)], "[finished-no-question] neither command asks about the recorded process").toEqual([]);
      installer.release();
      installer.child.stdin!.end();
      const done = await installer.done;
      expect.soft([done.code, resultOf(done.stdout)], `the held installer had finished normally\n${done.stdout}\n${done.stderr}`).toEqual([0, "INSTALLED"]);
    }
    // (2) An install in progress whose installer is alive: BUSY, nothing removed, one question.
    const { w } = workspace();
    writeFileSync(join(w, "notes.txt"), "the user's own notes\n");
    const held = lead(["install", ...claude(w)], [{ op: "linkSync", when: "before", match: dests("claude")[1], action: "block", name: "HELD" }]);
    expect(await held.phase("HELD"), "[phase-reached] the installer is held after its first publication").toBe(true);
    const unfinished = tree(w);
    const busy = await run(["uninstall", ...claude(w)]);
    expect.soft([busy.code, resultOf(busy.stdout), describeMutations(busy), tree(w)], `[unfinished-live-busy] uninstall while the installer of an unfinished install lives\n${busy.stdout}`).toEqual([2, "BUSY", [], unfinished]);
    expect.soft(questions(busy), "[unfinished-live-busy] it asked once, with signal 0, about the recorded id").toEqual([[held.child.pid, 0]]);
    held.kill();
    await held.done;
    // The installer is gone, but its id answers as alive, as not ours to ask, or with an unknown
    // error (as when another program has that id now): still BUSY, nothing removed.
    const probes: [string, (pid: number) => void][] = [
      ["a live process has the id", () => {}],
      ["asking is not permitted", () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }],
      ["the answer is an unknown error", () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }],
    ];
    for (const [name, probe] of probes) {
      let out = "";
      const asked: number[] = [];
      const exit = await main(["lead", "uninstall", ...claude(w)], { out: (s) => (out += s), err: () => {}, stdin: () => "" },
        { lead: { probe: (pid: number) => { asked.push(pid); probe(pid); } } } as never);
      expect.soft([exit, resultOf(out), asked, tree(w)], `[unfinished-live-busy] ${name}`).toEqual([2, "BUSY", [held.child.pid], unfinished]);
    }
    // (3) An install in progress whose installer has ended: uninstall removes what the record
    // lists (the files and directories that run created, then the state) and nothing else.
    const clean = await run(["uninstall", ...claude(w)]);
    expect.soft([clean.code, resultOf(clean.stdout)], `[unfinished-dead-cleans] uninstall after the installer of an unfinished install ended\n${clean.stdout}\n${clean.stderr}`).toEqual([0, "NOT_INSTALLED"]);
    expect.soft(tree(w), "[unfinished-dead-cleans] only the user's file is left").toEqual([`file notes.txt ${sha("the user's own notes\n")}`]);
    const listed = new Set([...dests("claude"), ...dests("claude").map((dest) => anchorOf("claude", dest)), ...createdDirs("claude"), ...STATE_DIRS,
      ".orch-lead-install/manifest.json", ".orch-lead-install/directories.json"]);
    expect.soft(mutations(clean).map((ev) => `${ev.op} ${relOf(w, ev.path)}`).filter((line) => !listed.has(line.split(" ").slice(1).join(" "))),
      "[unfinished-dead-cleans] every removal is of a path the record lists").toEqual([]);
    expect.soft([...new Set(questions(clean).map((q) => JSON.stringify(q)))], "[unfinished-dead-cleans] it asked about the recorded id with signal 0, and the answer was that no such process exists")
      .toEqual([JSON.stringify([held.child.pid, 0])]);

    // (4) Killed before it recorded the directories it made: uninstall removes the state and
    // leaves every directory, because nothing says which of them install created.
    const { w: early } = workspace();
    const s = lead(["install", ...claude(early)], [{ op: "mkdirSync", when: "before", match: `${H}/agents`, action: "block", name: "IN_DIRECTORIES" }]);
    expect(await s.phase("IN_DIRECTORIES"), "[phase-reached] the installer is held while it creates directories").toBe(true);
    s.kill();
    await s.done;
    const made = ["dir .claude", "dir .claude/skills", `dir ${H}`];
    expect(tree(early).filter((line) => !line.includes(".orch-lead-install")), "three directories exist, and nothing else outside the state").toEqual(made);
    const un = await run(["uninstall", ...claude(early)]);
    expect.soft([un.code, resultOf(un.stdout), tree(early)], `[no-record-no-removal] without a record of directories uninstall removes the state and leaves the directories\n${un.stdout}\n${un.stderr}`)
      .toEqual([0, "NOT_INSTALLED", made]);
    expect.soft(left(un.stdout, early), "[no-record-no-removal] and says why").toEqual({ ".claude": "no record that install created it", ".claude/skills": "no record that install created it", [H]: "no record that install created it" });
  });
});
