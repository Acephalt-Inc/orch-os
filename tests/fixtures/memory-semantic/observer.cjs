// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");

function blocked() {
  process.stderr.write("observer blocked a write, process, or network call\n");
  throw new Error("observer blocked");
}
for (const name of [
  "writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync",
  "rmdirSync", "copyFileSync", "symlinkSync", "linkSync", "chmodSync", "chownSync",
  "truncateSync", "ftruncateSync", "writeSync",
]) fs[name] = blocked;
const openSync = fs.openSync;
fs.openSync = (path, flags, ...rest) => {
  const write = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT |
    fs.constants.O_TRUNC | fs.constants.O_APPEND;
  if (typeof flags === "string") {
    if (flags !== "r" && flags !== "rs") return blocked();
  } else if (typeof flags !== "number" || (flags & write) !== 0) return blocked();
  return openSync(path, flags, ...rest);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = blocked;
net.connect = blocked;
net.createConnection = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
