// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test instrument, loaded into a child process with `node --import <this file> <program>`.
//
// It wraps the entry points a program needs to touch anything outside its own standard
// streams: the file system, child processes, the network, the home directory lookup and the
// environment. Each call is recorded by name. When the process exits, the record is written as
// one JSON line to file descriptor 3, which the test opens as an extra pipe; standard output
// and standard error stay exactly what the program wrote.
//
// The runtime itself goes through the same functions: its module loader reads the program's
// own files, and it looks at a few environment variables of its own. Those calls are kept
// apart under `runtime`. A file read counts as the loader's when the loader itself made it, or
// when the call stack has a loader frame and no frame of program code; its path is recorded so
// that the test can check it lies inside the program's own directory. A loader read that has no
// path (a read or a close of an open file descriptor) is recorded by name under `runtime.io`.
// An environment read counts as the runtime's when no frame of program code is on the stack, or
// when the module loader itself made the read while loading a module the program imports lazily.
//
// LEARNING_PROBE_NOW, when set, freezes the clock of the child at that instant. The variable is
// read and removed here, before the program starts, so the program cannot see it.
//
// probe-control.mjs, next to this file, is the proof that the wrappers are connected: it makes
// one call of each kind on purpose and the test expects every one of them in the record.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import workerThreads from "node:worker_threads";

const REPORT_FD = 3;
const SELF = import.meta.url;
const writeReport = fs.writeSync.bind(fs);

const record = { fs_write: [], fs_read: [], process: [], network: [], home: [], env: [] };
const runtime = { loaded: [], io: [], env: [] };

const frozen = process.env.LEARNING_PROBE_NOW;
delete process.env.LEARNING_PROBE_NOW;
if (frozen !== undefined) freezeClock(Date.parse(frozen));

/** `new Date()` and `Date.now()` give the frozen instant; a date built from a value is unchanged. */
function freezeClock(ms) {
  if (!Number.isFinite(ms)) throw new Error("LEARNING_PROBE_NOW is not a date");
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }
    static now() {
      return ms;
    }
  };
}

/**
 * Read frame file names as the engine reports them, without parsing stack text.
 * Code created by `eval` or `new Function` has no file name. An environment read from
 * such code with no program file on the stack is recorded as the runtime's.
 */
function sites() {
  const prepareStackTrace = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    Error.stackTraceLimit = 200;
    const frames = new Error().stack;
    return Array.isArray(frames) ? frames.slice(1) : [];
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = limit;
  }
}

function fileName(site) {
  const file = site.getFileName();
  return typeof file === "string" && file.length > 0 ? file : null;
}

/**
 * Who made the current call: "program" when a frame names a file other than this one
 * or a `node:` id, otherwise "loader" when the module loader is on the stack, otherwise "runtime".
 */
function origin() {
  let loaderFrame = false;
  for (const site of sites()) {
    const file = fileName(site);
    if (file === SELF) continue;
    if (file && !file.startsWith("node:")) return "program";
    if (file && file.startsWith("node:internal/modules/")) loaderFrame = true;
  }
  return loaderFrame ? "loader" : "runtime";
}

function pathOf(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return fileURLToPath(arg);
  if (Buffer.isBuffer(arg)) return arg.toString();
  return null;
}

// Calls made from inside a wrapped call are part of that call and are not recorded again.
let depth = 0;

function note(kind, label, args) {
  if (depth > 0) return;
  if (kind === "fs_read" && (madeByLoader() || origin() === "loader")) {
    // A loader read through an open file descriptor has no path: it is kept by name under `io`.
    const path = pathOf(args[0]);
    if (path === null) runtime.io.push(label);
    else runtime.loaded.push(path);
  } else record[kind].push(label);
}

/** Replace `owner[name]` with a function that records the call and then makes it. */
function wrap(owner, name, kind, label = name) {
  const original = owner[name];
  if (typeof original !== "function") return;
  const wrapper = function (...args) {
    note(typeof kind === "function" ? kind(args) : kind, label, args);
    depth++;
    try {
      return Reflect.apply(original, this, args);
    } finally {
      depth--;
    }
  };
  // Keep what hangs off the original, such as `realpathSync.native`.
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original));
  owner[name] = wrapper;
}

/** Replace a class with one that records each construction and each call. */
function wrapClass(owner, name, kind, label = name) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = new Proxy(original, {
    construct(target, args, newTarget) {
      note(kind, label, args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, self, args) {
      note(kind, label, args);
      return Reflect.apply(target, self, args);
    },
  });
}

// Functions of the file system module that change something, by the start of their name.
const FS_WRITE_NAMES = [
  "write", "append", "mkdir", "mkdtemp", "rm", "unlink", "rename", "copyFile", "cp", "symlink", "link",
  "truncate", "ftruncate", "chmod", "lchmod", "fchmod", "chown", "lchown", "fchown", "utimes", "lutimes", "futimes",
  "createWriteStream", "fsync", "fdatasync",
];
const FS_WRITE = new RegExp(`^(${FS_WRITE_NAMES.join("|")})`);

/** `open` writes unless its flags are absent or read-only. */
function openKind(args) {
  const flags = args[1];
  if (flags === undefined || flags === null || flags === "r" || flags === "rs" || flags === "sr") return "fs_read";
  if (typeof flags === "number" && (flags & 3) === fs.constants.O_RDONLY) return "fs_read";
  return "fs_write";
}

/** Every function the module exports, classes left alone: a write by its name, otherwise a read. */
function wrapFs(owner, prefix) {
  for (const name of Object.keys(owner)) {
    if (typeof owner[name] !== "function" || /^[A-Z_]/.test(name)) continue;
    const label = prefix + name;
    if (/^open(Sync)?$/.test(name)) wrap(owner, name, openKind, label);
    else wrap(owner, name, FS_WRITE.test(name) ? "fs_write" : "fs_read", label);
  }
}

wrapFs(fs, "fs.");
wrapFs(fs.promises, "fs.promises.");

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  wrap(childProcess, name, "process", `child_process.${name}`);
}
wrapClass(workerThreads, "Worker", "process", "worker_threads.Worker");

for (const name of ["connect", "createConnection", "createServer"]) wrap(net, name, "network", `net.${name}`);
wrap(net.Socket.prototype, "connect", "network", "net.Socket.connect");
wrap(tls, "connect", "network", "tls.connect");
wrap(dgram, "createSocket", "network", "dgram.createSocket");
wrap(http2, "connect", "network", "http2.connect");
for (const [mod, label] of [[http, "http"], [https, "https"]]) {
  for (const name of ["request", "get", "createServer"]) wrap(mod, name, "network", `${label}.${name}`);
}
for (const [mod, label] of [[dns, "dns"], [dns.promises, "dns.promises"]]) {
  for (const name of Object.keys(mod)) {
    if (/^(lookup|resolve|reverse)/.test(name)) wrap(mod, name, "network", `${label}.${name}`);
  }
}
wrap(globalThis, "fetch", "network", "fetch");
wrapClass(globalThis, "WebSocket", "network", "WebSocket");

wrap(os, "homedir", "home", "os.homedir");
wrap(os, "userInfo", "home", "os.userInfo");

// Named imports of a built-in module (`import { writeFileSync } from "node:fs"`) see the
// wrappers only after this call.
syncBuiltinESMExports();

/**
 * True when the code that made the current call is the runtime's module loader itself. A newer
 * runtime starts loading a lazily imported module on the stack of the program that imports it,
 * so the loader's own reads would otherwise look like the program's.
 */
function madeByLoader() {
  for (const site of sites()) {
    const file = fileName(site);
    if (file === SELF) continue;
    // The first frame outside this probe decides. A program file is a `file:` URL or a path and
    // never starts with `node:`, whatever its path contains.
    return !!(file && file.startsWith("node:internal/modules/"));
  }
  return false;
}

function noteEnv(key) {
  if (typeof key !== "string" || depth > 0) return;
  (!madeByLoader() && origin() === "program" ? record.env : runtime.env).push(key);
}

// Every read of an environment variable by name, and every listing of the environment ("*").
process.env = new Proxy(process.env, {
  get(target, key, receiver) {
    noteEnv(key);
    return Reflect.get(target, key, receiver);
  },
  has(target, key) {
    noteEnv(key);
    return Reflect.has(target, key);
  },
  getOwnPropertyDescriptor(target, key) {
    noteEnv(key);
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
  ownKeys(target) {
    noteEnv("*");
    return Reflect.ownKeys(target);
  },
});

process.on("exit", () => {
  depth++;
  const line = JSON.stringify({ probe: "learning-probe", clock: frozen ?? null, ...record, runtime }) + "\n";
  try {
    writeReport(REPORT_FD, line);
  } catch {
    // No report pipe: a test that needs the record fails on its absence.
  }
});
