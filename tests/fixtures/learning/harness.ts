// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Shared by the three learning test files: the compiled entry as a child process (with or
// without the effect probe), the command in this process, and synthetic documents.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach } from "vitest";
import { main } from "../../../src/learning/command.js";

const HERE = realpathSync(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(dirname(dirname(HERE)));

export const DIST = join(ROOT, "dist");
export const ENTRY = join(DIST, "learning", "entry.js");
export const COMMAND_URL = pathToFileURL(join(DIST, "learning", "command.js")).href;
export const PROBE_URL = pathToFileURL(join(HERE, "probe.mjs")).href;
export const CONTROL = join(HERE, "probe-control.mjs");

/** The instant every fixed-clock test runs at; the fixture events are active then. */
export const NOW = "2026-10-13T12:00:00.000Z";
export const RECORDED = "2026-10-12T12:00:00.000Z";
export const EXPIRES = "2026-11-12T12:00:00.000Z";

export const INPUT = readFileSync(join(HERE, "input.json"));
export const EXPECTED = JSON.parse(readFileSync(join(HERE, "expected.json"), "utf8"));

export const MAX_BYTES = 65_536;

/** The one line an error prints on standard error. */
export const errorLine = (code: string) => `{"code":"${code}","status":"ERROR"}\n`;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Canonical JSON written a second time here, so a test never asks the product for it. */
export function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

// ---- the fixture, written out as literal canonical text ----------------------------------------
// Expected IDs and digests are SHA-256 of these literals, never of anything the product returns.

export const LESSON_EVENT =
  `{"event_id":"check-dates","event_revision":1,"expires_at":"2026-11-12T12:00:00.000Z","kind":"lesson-note",` +
  `"recorded_at":"2026-10-12T12:00:00.000Z","state":"active","text":"Check invoice dates before drafting a reminder."}`;
export const SETTING_EVENT =
  `{"event_id":"short-answers","event_revision":1,"expires_at":"2026-11-12T12:00:00.000Z","key":"answer-length",` +
  `"kind":"setting-correction","recorded_at":"2026-10-12T12:00:00.000Z","state":"active","value":"short"}`;
export const SETTINGS = `{"revision":3,"schema_version":1,"values":{"answer-length":"normal","response-language":"en"}}`;

export const LESSON_ID = sha256(`{"event":${LESSON_EVENT},"settings":null}`);
export const SETTING_ID = sha256(`{"event":${SETTING_EVENT},"settings":${SETTINGS}}`);
export const SOURCE_DIGEST = sha256(`{"events":[${LESSON_EVENT},${SETTING_EVENT}],"settings":${SETTINGS}}`);

export const LESSON_DRAFT =
  `{"authority":"user-supplied-unverified","conflict":false,` +
  `"effect":{"quoted_note":"Check invoice dates before drafting a reminder."},"evaluation":"not-run",` +
  `"event_id":"check-dates","event_revision":1,"expires_at":"2026-11-12T12:00:00.000Z","id":"${LESSON_ID}",` +
  `"kind":"lesson","status":"DRAFT"}`;
export const SETTING_DRAFT =
  `{"authority":"user-supplied-unverified","conflict":false,` +
  `"effect":{"after":"short","before":"normal","before_known":true,"expected_settings_revision":3,"key":"answer-length"},` +
  `"evaluation":"not-run","event_id":"short-answers","event_revision":1,"expires_at":"2026-11-12T12:00:00.000Z",` +
  `"id":"${SETTING_ID}","kind":"setting","status":"DRAFT"}`;

function documentText(revision: number, drafts: string[], rejections: string[]): string {
  return (
    `{"drafts":[${drafts.join(",")}],"events":[${LESSON_EVENT},${SETTING_EVENT}],"omitted_event_ids":[],` +
    `"rejections":[${rejections.join(",")}],"revision":${revision},"schema_version":1,"scope":"personal",` +
    `"settings":${SETTINGS},"source_digest":"${SOURCE_DIGEST}"}\n`
  );
}

/** What `review` prints for the fixture at NOW, byte for byte. */
export const REVIEWED = documentText(1, [LESSON_DRAFT, SETTING_DRAFT], []);
/** What `reject <setting ID> --expected-revision 1` prints for REVIEWED. */
export const REJECTED = documentText(2, [LESSON_DRAFT], [`{"id":"${SETTING_ID}"}`]);
/** What `show` prints for REVIEWED. */
export const SHOWN =
  `{"drafts":[${LESSON_DRAFT},${SETTING_DRAFT}],"omitted_event_ids":[],"revision":1,"scope":"personal",` +
  `"status":"DRAFTS_ONLY"}\n`;

// ---- synthetic documents ---------------------------------------------------------------------

export const fixture = () => JSON.parse(INPUT.toString("utf8"));

export function note(event_id: string, text: string, extra: Record<string, unknown> = {}) {
  return { event_id, event_revision: 1, state: "active", recorded_at: RECORDED, expires_at: EXPIRES, kind: "lesson-note", text, ...extra };
}

export function setting(event_id: string, key: string, value: string, extra: Record<string, unknown> = {}) {
  return { event_id, event_revision: 1, state: "active", recorded_at: RECORDED, expires_at: EXPIRES, kind: "setting-correction", key, value, ...extra };
}

/** An initial review input with these events. */
export function initial(events: unknown[], settings: unknown = null) {
  return { schema_version: 1, scope: "personal", revision: 0, settings, events, rejections: [], source_digest: null, drafts: [], omitted_event_ids: [] };
}

/** A distinct well-formed proposal ID for each number. */
export const marker = (n: number) => ({ id: n.toString(16).padStart(64, "0") });

// ---- the command in this process -------------------------------------------------------------

export interface Outcome {
  code: number;
  out: string;
  err: string;
  /** How many times the command asked for its input. */
  reads: number;
}

/** Run one command in this process on a fixed clock. */
export async function invoke(args: string[], data: Uint8Array | string | object, now = NOW): Promise<Outcome> {
  const input = typeof data === "string" || data instanceof Uint8Array ? data : JSON.stringify(data);
  const got: Outcome = { code: -1, out: "", err: "", reads: 0 };
  const io = {
    read: async () => {
      got.reads++;
      return input;
    },
    out: (s: string) => void (got.out += s),
    err: (s: string) => void (got.err += s),
  };
  got.code = await main(args, io, { now: () => new Date(now) });
  return got;
}

/** The document a successful review or reject printed. */
export function printed(o: Outcome | Child) {
  const text = "out" in o ? o.out : o.stdout;
  const code = "out" in o ? o.code : o.status;
  if (code !== 0) throw new Error(`the command failed: ${"out" in o ? o.err : o.stderr}`);
  return JSON.parse(text);
}

// ---- the compiled entry as a child process ---------------------------------------------------

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory under the real temporary directory, removed after the test. */
export function scratch(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-t-"));
  scratchDirs.push(dir);
  return dir;
}

export const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** What the probe recorded in the child; see probe.mjs. */
export interface ProbeRecord {
  probe: string;
  clock: string | null;
  fs_write: string[];
  fs_read: string[];
  process: string[];
  network: string[];
  home: string[];
  env: string[];
  /** What the runtime did for itself: the files its module loader read, the variables it looked at. */
  runtime: { loaded: string[]; env: string[] };
}

export interface Child {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  record: ProbeRecord;
}

export interface ChildOptions {
  /** Extra environment for the child, on top of the minimal one. */
  env?: Record<string, string>;
  /** The directory the home variables point at; a fresh scratch directory by default. */
  home?: string;
  /** The working directory; the home directory by default. */
  cwd?: string;
  /** Freeze the child's clock here; null leaves the real clock. */
  now?: string | null;
}

/**
 * The environment a child gets: what a process needs to start, and nothing of the person
 * running the tests. The home variables point at `home`, a scratch directory.
 */
export function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home };
  for (const key of ["PATH", "Path", "SystemRoot", "TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function probed(program: string[], stdin: Uint8Array | string, o: ChildOptions): Child {
  const home = o.home ?? scratch();
  const env = childEnv(home, o.env);
  if (o.now !== null) env.LEARNING_PROBE_NOW = o.now ?? NOW;
  const r = spawnSync(process.execPath, ["--import", PROBE_URL, ...program], {
    input: stdin,
    encoding: "utf8",
    env,
    cwd: o.cwd ?? home,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: 55_000,
    killSignal: "SIGKILL",
  });
  // An empty or broken report fails here: a run without a record proves nothing.
  const record: ProbeRecord = JSON.parse(String(r.output[3]));
  if (record.probe !== "learning-probe") throw new Error("no probe record");
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, record };
}

/** Run the compiled entry under the probe, on a frozen clock unless `now` is null. */
export function runEntry(args: string[], stdin: Uint8Array | string | object, o: ChildOptions = {}): Child {
  const input = typeof stdin === "string" || stdin instanceof Uint8Array ? stdin : JSON.stringify(stdin);
  return probed([ENTRY, ...args], input, o);
}

/** Run any program under the probe, with the real clock. */
export function runProbed(program: string[], o: ChildOptions = {}): Child {
  return probed(program, "", { now: null, ...o });
}

export interface OpenChild {
  code: number | null;
  signal: string | null;
  /** True when the test had to kill the child at its own deadline. */
  killedByTest: boolean;
  /** Wall time from spawn to exit, in milliseconds. */
  ms: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the compiled entry with a standard input that is written to but never closed. The child
 * is killed at `hardDeadlineMs` if it is still alive, so this cannot hang the test run.
 */
export function runWithOpenStdin(args: string[], written: Uint8Array | null, hardDeadlineMs: number): Promise<OpenChild> {
  return new Promise((resolve) => {
    const started = Date.now();
    const home = scratch();
    const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ["pipe", "pipe", "pipe"], env: childEnv(home), cwd: home });
    const got: OpenChild = { code: null, signal: null, killedByTest: false, ms: 0, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (got.stdout += d));
    child.stderr.on("data", (d) => (got.stderr += d));
    child.stdin.on("error", () => {});
    if (written) child.stdin.write(written);
    const killer = setTimeout(() => {
      got.killedByTest = true;
      child.kill("SIGKILL");
    }, hardDeadlineMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      got.ms = Date.now() - started;
      got.code = code;
      got.signal = signal;
      child.stdin.destroy();
      resolve(got);
    });
  });
}
