// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import fs from "node:fs";
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import workers from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
const append = fs.writeSync;
const fd = fs.openSync(process.env.ADMISSION_TRACE, "a");
let phase;
let counter = 0;
let inside = false;
globalThis[Symbol.for("admission.trace")] = (label, deadline, clock) => {
  phase = label ? { label, deadline, clock } : undefined;
};
function record(data) {
  append(fd, JSON.stringify({ ...phase, budgetTime: phase?.clock?.() ?? performance.now(), ...data }) + "\n");
}
globalThis[Symbol.for("admission.await")] = async (name, action) => {
  const id = ++counter;
  record({ id, op: "seam." + name, event: "submit", at: performance.now() });
  try {
    const result = await action();
    record({ id, op: "seam." + name, event: "complete", at: performance.now() });
    return result;
  } catch (error) {
    record({ id, op: "seam." + name, event: "complete", at: performance.now(), error: error.code });
    throw error;
  }
};
function identity(value) {
  return value && typeof value.ino === "number" ? { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, nlink: value.nlink } : undefined;
}
function traced(owner, name, label, path) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function (...args) {
    if (!phase || inside) return original.apply(this, args);
    const id = ++counter;
    const op = label + name;
    record({ id, op, event: "submit", at: performance.now(), path: path ?? String(args[0]), flags: name.startsWith("open") ? args[1] : undefined });
    let value;
    inside = true;
    try {
      value = original.apply(this, args);
    } catch (error) {
      record({ id, op, event: "complete", at: performance.now(), error: error.code });
      throw error;
    } finally {
      inside = false;
    }
    function done(result) {
      record({ id, op, event: "complete", at: performance.now(), identity: identity(result), bytes: result?.bytesRead });
      if (name === "open" && result?.close) {
        for (const method of ["stat", "read", "readFile", "write", "writeFile", "sync", "chmod", "chown", "truncate", "close"]) {
          traced(result, method, "handle.", String(args[0]));
        }
      }
      return result;
    }
    if (value?.then) return value.then(done, (error) => {
      record({ id, op, event: "complete", at: performance.now(), error: error.code });
      throw error;
    });
    return done(value);
  };
  Object.assign(owner[name], original);
}
for (const owner of [fs, fs.promises]) {
  for (const name of Object.keys(owner)) {
    if (/^(open|read|write|append|mkdir|rmdir|rm|unlink|rename|link|symlink|chmod|chown|truncate|stat|lstat|realpath|copy|cp|access)/.test(name)) {
      traced(owner, name, owner === fs ? "fs." : "fs.promises.");
    }
  }
}
for (const [label, owner, names] of [
  ["child_process.", childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
  ["net.", net, ["connect", "createConnection", "createServer"]],
  ["http.", http, ["request", "get", "createServer"]],
  ["https.", https, ["request", "get", "createServer"]],
  ["dns.", dns, ["lookup", "resolve", "resolve4", "resolve6"]],
  ["worker_threads.", workers, ["Worker"]],
]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function (...args) {
      if (phase) {
        record({ op: label + name, event: "submit", at: performance.now() });
        throw new Error("unexpected external call");
      }
      return new.target ? Reflect.construct(original, args) : original.apply(this, args);
    };
  }
}
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (...args) => {
  if (phase) {
    record({ op: "fetch", event: "submit", at: performance.now() });
    throw new Error("unexpected external call");
  }
  return fetchOriginal(...args);
};
syncBuiltinESMExports();
