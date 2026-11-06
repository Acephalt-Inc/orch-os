// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test-only entry: runs the exported main() of a compiled cli.js in this process and reports, as
// one JSON line on file descriptor 3, every file-changing fs call and every child-process start
// made from the moment the wrappers are installed until the process exits.
//
//   node tests/_observe-entry.mjs <path to dist/cli.js> [orch arguments...]
//
// It observes calls, not results: a write that leaves the same bytes behind, or a file that is
// created and removed again, is still reported.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  for (const name of [base, `${base}Sync`]) wrap(fs, name, (a) => ops.push({ kind: "fs", op: name, path: shown(a[0]) }));
  wrap(fs.promises, base, (a) => ops.push({ kind: "fs", op: `promises.${base}`, path: shown(a[0]) }));
}
for (const base of FD_CHANGERS) {
  // descriptors 0-2 are the standard streams; 3 carries this report
  for (const name of [base, `${base}Sync`]) wrap(fs, name, (a) => { if (a[0] > 3) ops.push({ kind: "fs", op: name, path: `fd ${a[0]}` }); });
}
for (const name of ["open", "openSync"]) wrap(fs, name, (a) => { if (opensForChange(a[1])) ops.push({ kind: "fs", op: name, path: shown(a[0]) }); });
wrap(fs.promises, "open", (a) => { if (opensForChange(a[1])) ops.push({ kind: "fs", op: "promises.open", path: shown(a[0]) }); });
wrap(fs, "createWriteStream", (a) => ops.push({ kind: "fs", op: "createWriteStream", path: shown(a[0]) }));
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  wrap(cp, name, (a) => ops.push({ kind: "process", op: name, path: shown(a[0]) }));
}
syncBuiltinESMExports();

let code = null;
let failure = null;
process.on("exit", () => {
  report(3, JSON.stringify({ ops, code, failure }) + "\n");
});

const [cli, ...argv] = process.argv.slice(2);
try {
  const { main } = await import(pathToFileURL(cli).href);
  code = await main(argv);
  process.exitCode = code;
} catch (e) {
  failure = String(e?.stack ?? e);
  process.stderr.write(`observe entry: ${failure}\n`);
  process.exitCode = 70;
}
