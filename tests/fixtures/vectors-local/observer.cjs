const fs = require("node:fs");
const childProcess = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const originalWrite = fs.write;
const originalWriteSync = fs.writeSync;

let violations = 0;
function forbidden(kind) {
  violations++;
  throw new Error("observer blocked " + kind);
}

for (const name of [
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream",
  "mkdir", "mkdirSync", "rename", "renameSync", "unlink", "unlinkSync", "rm", "rmSync",
]) {
  fs[name] = () => forbidden("filesystem write");
}
fs.write = function (fd, ...args) {
  if (fd !== 1 && fd !== 2) return forbidden("filesystem write");
  return originalWrite.call(this, fd, ...args);
};
fs.writeSync = function (fd, ...args) {
  if (fd !== 1 && fd !== 2) return forbidden("filesystem write");
  return originalWriteSync.call(this, fd, ...args);
};
for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm"]) {
  fs.promises[name] = () => forbidden("filesystem write");
}
const openSync = fs.openSync;
fs.openSync = function (path, flags, ...rest) {
  if (typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0
    : /[wax+]/.test(flags)) return forbidden("filesystem open for write");
  return openSync.call(this, path, flags, ...rest);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => forbidden("child process");
}
globalThis.fetch = () => forbidden("fetch");
let dials = 0;
let requests = 0;
const request = http.request;
http.request = function (options, ...args) {
  requests++;
  if (process.env.ORCH_VECTOR_EXPECT_NO_DIAL === "1") return forbidden("HTTP request");
  const host = options.hostname ?? options.host;
  const port = Number(options.port);
  if (host !== "127.0.0.1" || port !== Number(process.env.ORCH_VECTOR_EXPECT_PORT)) return forbidden("HTTP target");
  return request.call(this, options, ...args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  dials++;
  if (process.env.ORCH_VECTOR_EXPECT_NO_DIAL === "1") return forbidden("dial");
  const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
  const host = options.hostname ?? options.host;
  const port = Number(options.port);
  if (host !== "127.0.0.1" || port !== Number(process.env.ORCH_VECTOR_EXPECT_PORT)) return forbidden("dial target");
  return connect.apply(this, args);
};
process.on("exit", () => {
  if (violations !== 0) process.stderr.write("observer violation\n");
  if (process.env.ORCH_VECTOR_EXPECT_NO_DIAL === "1" && requests !== 0) process.stderr.write("observer saw request\n");
  if (process.env.ORCH_VECTOR_EXPECT_NO_DIAL === "1" && dials !== 0) process.stderr.write("observer saw dial\n");
});
syncBuiltinESMExports();
