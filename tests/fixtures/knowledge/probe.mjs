// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test instrument, loaded with `node --import` ahead of the program under test. It wraps the
// public file, network and process entry points of Node, lets every call through unchanged, and
// writes one JSON report to file descriptor 3 when the process exits. It also pins the clock
// when KNOWLEDGE_PROBE_CLOCK is set, so two runs can be compared byte for byte.
//
// Limits: only the entry points listed below are wrapped. Code that reaches an internal binding
// directly, or that kept a reference from before this file ran (Node's own module loader does),
// is not seen.
import childProcess from "node:child_process";
import cluster from "node:cluster";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import workerThreads from "node:worker_threads";

const REPORT_FD = 3;
const writeReport = fs.writeSync;
const calls = [];
/** Open file descriptors by number, so a later read or close is reported with its path. */
const opened = new Map();

function targetOf(arg) {
  if (typeof arg === "number") return opened.get(arg) ?? `fd:${arg}`;
  if (arg instanceof URL) return arg.protocol === "file:" ? fileURLToPath(arg) : arg.href;
  if (typeof arg === "string") return arg.startsWith("file:") ? fileURLToPath(arg) : arg;
  if (arg && typeof arg === "object" && typeof arg.path === "string") return arg.path;
  return "";
}

/** The flags of an `open` call; no other second argument is kept, so file content never is. */
function detailOf(name, arg) {
  const flags = typeof arg === "string" || typeof arg === "number";
  return name.endsWith("openSync") && flags ? arg : null;
}

function record(kind, name, args) {
  const entry = { kind, name, target: targetOf(args[0]), detail: detailOf(name, args[1]) };
  calls.push(entry);
  return entry;
}

function wrap(owner, key, kind, name) {
  const original = owner[key];
  if (typeof original !== "function") return;
  owner[key] = new Proxy(original, {
    apply(target, self, args) {
      const entry = record(kind, name, args);
      const result = Reflect.apply(target, self, args);
      if (name === "fs.openSync") opened.set(result, entry.target);
      if (name === "fs.closeSync") opened.delete(args[0]);
      return result;
    },
    construct(target, args, newTarget) {
      record(kind, name, args);
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** Every plain function of a module object; classes and private helpers are left alone. */
function wrapFunctions(owner, kind, prefix) {
  for (const key of Object.keys(owner)) {
    if (/^[a-z]/.test(key)) wrap(owner, key, kind, `${prefix}.${key}`);
  }
}

wrap(fs.realpath, "native", "file", "fs.realpath.native");
wrap(fs.realpathSync, "native", "file", "fs.realpathSync.native");
wrapFunctions(fs.promises, "file", "fs.promises");
wrapFunctions(fs, "file", "fs");

for (const key of ["connect", "createConnection", "createServer"]) wrap(net, key, "network", `net.${key}`);
wrap(net.Socket.prototype, "connect", "network", "net.Socket.connect");
wrap(net.Server.prototype, "listen", "network", "net.Server.listen");
for (const key of ["connect", "createServer"]) wrap(tls, key, "network", `tls.${key}`);
for (const key of ["request", "get", "createServer"]) {
  wrap(http, key, "network", `http.${key}`);
  wrap(https, key, "network", `https.${key}`);
}
for (const key of ["connect", "createServer", "createSecureServer"]) wrap(http2, key, "network", `http2.${key}`);
wrap(dgram, "createSocket", "network", "dgram.createSocket");
for (const key of ["bind", "connect", "send"]) wrap(dgram.Socket.prototype, key, "network", `dgram.Socket.${key}`);
wrapFunctions(dns.promises, "network", "dns.promises");
wrapFunctions(dns, "network", "dns");
for (const key of ["fetch", "WebSocket", "EventSource"]) wrap(globalThis, key, "network", key);

for (const key of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
  wrap(childProcess, key, "process", `child_process.${key}`);
}
wrap(cluster, "fork", "process", "cluster.fork");
wrap(workerThreads, "Worker", "process", "worker_threads.Worker");

// Named imports of the built-in modules read these wrapped functions from here on.
syncBuiltinESMExports();

const fixedClock = process.env.KNOWLEDGE_PROBE_CLOCK;
if (fixedClock) {
  const RealDate = Date;
  const at = RealDate.parse(fixedClock);
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(at);
      else super(...args);
    }

    static now() {
      return at;
    }
  };
}

process.on("exit", () => {
  try {
    writeReport(REPORT_FD, JSON.stringify({ calls }));
  } catch {
    // No report channel was opened by the caller.
  }
});
