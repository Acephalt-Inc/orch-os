// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
const fs = require("node:fs");
const promises = require("node:fs/promises");
const child = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const workers = require("node:worker_threads");
const { join, sep } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const output = fs.writeSync;
const root = join(process.env.HOME, ".orch-private") + sep;
const writes = [];
function blocked() {
  throw new Error("observer blocked an external effect");
}
function checked(name, path) {
  if (typeof path !== "string" || !(path === root.slice(0, -1) || path.startsWith(root))) blocked();
  writes.push({ name, path });
}
for (const name of ["mkdir", "open", "rename", "rmdir", "unlink"]) {
  const original = promises[name];
  promises[name] = (...args) => {
    checked(name, args[0]);
    if (name === "rename") checked(name, args[1]);
    return original(...args);
  };
}
for (const name of [
  "writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync",
  "copyFileSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "truncateSync", "ftruncateSync",
]) fs[name] = blocked;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[name] = blocked;
for (const name of ["connect", "createConnection"]) net[name] = blocked;
for (const module of [http, https]) {
  for (const name of ["request", "get"]) module[name] = blocked;
}
dns.lookup = blocked;
workers.Worker = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
process.on("exit", () => output(3, JSON.stringify({ writes }) + "\n"));
