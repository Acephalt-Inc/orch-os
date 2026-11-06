// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test fixture, loaded with `node --import` before the built command. It wraps every path-taking
// function of the file-system module, callback, synchronous and promise forms, and appends one JSON
// line per call to the file named by FS_TRACE_FILE: {"op": name, "paths": [first path, second path]}.
// A test reads the lines to see which paths the command asked the file system about, and how.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const writeSync = fs.writeSync;
const log = fs.openSync(process.env.FS_TRACE_FILE, "a");
const TWO_PATHS = /^(rename|link|symlink|copyFile|cp)(Sync)?$/;
let inside = false;

function isPath(value) {
  return typeof value === "string" || value instanceof URL || Buffer.isBuffer(value);
}

function wrap(owner, label) {
  for (const name of Object.keys(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor || typeof descriptor.value !== "function" || !/^[a-z]/.test(name)) continue;
    const real = descriptor.value;
    const traced = function (...args) {
      // A call made from inside another traced call belongs to the runtime, not to the command.
      if (inside || !isPath(args[0])) return real.apply(this, args);
      const paths = [String(args[0])];
      if (TWO_PATHS.test(name) && isPath(args[1])) paths.push(String(args[1]));
      writeSync(log, `${JSON.stringify({ op: `${label}${name}`, paths })}\n`);
      inside = true;
      try { return real.apply(this, args); } finally { inside = false; }
    };
    Object.assign(traced, real);
    owner[name] = traced;
  }
}

wrap(fs.promises, "promises.");
wrap(fs, "");
// Named imports of the built-in module, in the command and everything it loads, now see the wrappers.
syncBuiltinESMExports();
