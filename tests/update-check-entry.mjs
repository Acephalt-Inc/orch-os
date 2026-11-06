// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test-only entry for `orch update check`. It runs the exported main() of a compiled cli.js in this
// process and reports, as one JSON line on file descriptor 3, every file-changing fs call, every
// child-process start and every outbound connection attempt made until the process exits.
//
//   node tests/update-check-entry.mjs <path to dist/cli.js> <address | - | hold> [orch arguments...]
//
// <address> reaches the CLI only as main()'s `runtime.updateUrl`; `-` and `hold` pass no address, so
// the CLI uses its own. Without orch arguments it runs `update check`.
//
// It observes calls, not results: a file that is written and removed again is still reported.
// A connection to anything but 127.0.0.1 is reported and never opened, before any name lookup, so
// a test can never reach a real network through this entry: with `hold` it stays unanswered, like
// a host that does not reply to the connection; otherwise it is refused.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { pathToFileURL } from "node:url";

const ops = [];
const report = fs.writeSync;
const shown = (v) => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString() : v instanceof URL ? v.pathname : String(v));

/** Does an fs.open flag ask for anything other than reading an existing file? */
function opensForChange(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") {
    const c = fs.constants;
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0;
  }
  return !["r", "rs", "sr"].includes(String(flags));
}

// A call made from inside another wrapped call (Node implements some fs functions with others) is
// part of the outer one and is not reported a second time.
let depth = 0;
function wrap(owner, name, record) {
  const real = owner[name];
  if (typeof real !== "function") return;
  owner[name] = function (...args) {
    if (depth === 0) record(args);
    depth++;
    try {
      return real.apply(this, args);
    } finally {
      depth--;
    }
  };
}

const CHANGERS = ["appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link", "lutimes", "mkdir", "mkdtemp",
  "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"];
const FD_CHANGERS = ["ftruncate", "futimes", "fchmod", "fchown", "write", "writev"];

for (const base of CHANGERS) {
  for (const name of [base, `${base}Sync`]) wrap(fs, name, (a) => ops.push({ kind: "fs", op: name, target: shown(a[0]) }));
  wrap(fs.promises, base, (a) => ops.push({ kind: "fs", op: `promises.${base}`, target: shown(a[0]) }));
}
for (const base of FD_CHANGERS) {
  // descriptors 0-2 are the standard streams; 3 carries this report
  for (const name of [base, `${base}Sync`]) wrap(fs, name, (a) => { if (a[0] > 3) ops.push({ kind: "fs", op: name, target: `fd ${a[0]}` }); });
}
for (const name of ["open", "openSync"]) wrap(fs, name, (a) => { if (opensForChange(a[1])) ops.push({ kind: "fs", op: name, target: shown(a[0]) }); });
wrap(fs.promises, "open", (a) => { if (opensForChange(a[1])) ops.push({ kind: "fs", op: "promises.open", target: shown(a[0]) }); });
wrap(fs, "createWriteStream", (a) => ops.push({ kind: "fs", op: "createWriteStream", target: shown(a[0]) }));
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  wrap(cp, name, (a) => ops.push({ kind: "process", op: name, target: shown(a[0]) }));
}

// Every TCP and TLS connection starts in net.Socket.prototype.connect.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof first === "object" && first !== null ? first : typeof first === "number" ? { port: first, host: args[1] } : { path: first };
  const host = typeof o.host === "string" ? o.host : "localhost";
  const target = o.path ? `path ${o.path}` : `${host}:${o.port}`;
  ops.push({ kind: "connect", op: "connect", target });
  if (!o.path && host === "127.0.0.1") return connect.apply(this, args);
  // never opened. Refused after a short wait, so the request that owns this socket is listening
  // for the error; with `hold`, left without an answer.
  if (process.argv[3] !== "hold") {
    setTimeout(() => this.destroy(Object.assign(new Error(`connection to ${target} refused by the test entry`), { code: "ECONNREFUSED" })), 20);
  }
  return this;
};
syncBuiltinESMExports();

let code = null;
let failure = null;
process.on("exit", () => {
  report(3, JSON.stringify({ ops, code, failure }) + "\n");
});

const [cli, address, ...rest] = process.argv.slice(2);
try {
  const { main } = await import(pathToFileURL(cli).href);
  code = await main(rest.length ? rest : ["update", "check"], undefined, address === "-" || address === "hold" ? {} : { updateUrl: address });
  process.exitCode = code;
} catch (e) {
  failure = String(e?.stack ?? e);
  process.stderr.write(`update-check entry: ${failure}\n`);
  process.exitCode = 70;
}
