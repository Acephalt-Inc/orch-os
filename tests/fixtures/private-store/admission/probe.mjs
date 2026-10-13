// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { bindWorkspace, partitionPaths } from "../../../../dist/private-store/binding.js";
import { inspectPartition, preparePartition, openPrivateFile, readBounded } from "../../../../dist/private-store/privacy.js";
const [workspace, scenario = "binding"] = process.argv.slice(2);
const home = await realpath(process.env.HOME);
const setPhase = globalThis[Symbol.for("admission.trace")] ?? (() => {});
const observed = globalThis[Symbol.for("admission.await")] ?? ((_name, action) => action());
const nextBudget = () => performance.now() + 5_000;
async function call(label, action, deadline = nextBudget(), clock) {
  setPhase(label, deadline, clock);
  try {
    const value = await action(deadline);
    if (value?.handle) {
      await value.handle.close();
      return { value: { kind: value.kind } };
    }
    return { value };
  } catch (error) {
    return { code: error.code, message: error.message, cause: error.cause };
  } finally {
    setPhase();
  }
}
const digest = (path) => createHash("sha256").update(path).digest("hex");
const directory = join(home, ".orch-private", "memory-v1", "personal", digest(await realpath(workspace)));
const folders = [dirname(dirname(dirname(directory))), dirname(dirname(directory)), dirname(directory), directory];
function inventory(path) {
  const entries = [];
  if (!lstatSync(path, { throwIfNoEntry: false })) return entries;
  for (const name of readdirSync(path).sort()) {
    const absolute = join(path, name);
    const info = lstatSync(absolute);
    entries.push({ name, ino: info.ino, mode: info.mode & 0o7777, uid: info.uid, nlink: info.nlink,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      bytes: info.isFile() ? readFileSync(absolute).toString("hex") : undefined });
    if (info.isDirectory()) entries.push(...inventory(absolute).map((entry) => ({ ...entry, name: name + "/" + entry.name })));
  }
  return entries;
}
async function bind(seam = {}) {
  return bindWorkspace(workspace, "memory-v1", nextBudget(), seam);
}
async function ready() {
  const binding = await bind();
  await preparePartition(binding, nextBudget());
  return binding;
}
async function read(binding, cap, seam = {}) {
  const budget = nextBudget();
  const result = await openPrivateFile(binding, "state.json", budget);
  if (result.kind !== "present") return result;
  return { bytes: (await readBounded(result.handle, cap, budget, seam)).toString("hex") };
}
async function bindingCases() {
  const plain = await call("bind", (budget) => bindWorkspace(workspace, "memory-v1", budget));
  if (plain.code) return plain;
  const binding = plain.value;
  const paths = partitionPaths(binding);
  const ancestorPaths = [];
  for (let path = home;; path = dirname(path)) {
    ancestorPaths.push(path);
    if (path === dirname(path)) break;
  }
  const ancestorInfo = () => ancestorPaths.map((path) => {
    const info = lstatSync(path);
    return { path, mode: info.mode, ino: info.ino, uid: info.uid };
  });
  const ancestorsBefore = ancestorInfo();
  const other = join(home, "second", "workspace");
  const unicode = join(home, "空 白", "workspace");
  await mkdir(other, { recursive: true });
  await mkdir(unicode, { recursive: true });
  const otherBinding = await bindWorkspace(other, "memory-v1", nextBudget());
  const unicodeBinding = await bindWorkspace(unicode, "knowledge-v1", nextBudget());
  const linked = join(home, "workspace-alias");
  await symlink(workspace, linked);
  const linkedResult = await call("linked-workspace", (budget) => bindWorkspace(linked, "memory-v1", budget));
  const traversal = await call("linked-traversal", (budget) => bindWorkspace(linked + "/../workspace", "memory-v1", budget));
  const cases = [join(home, "CaseDir"), join(home, "casedir")];
  await mkdir(cases[0]);
  let alias;
  try {
    const first = await realpath(cases[0]);
    const second = await realpath(cases[1]);
    alias = { same: first === second, digests: [digest(first), digest(second)] };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    alias = { skip: "realpath aliases do not exist on this case-sensitive volume" };
  }
  const namespaces = [];
  for (const namespace of ["memory-v1", "knowledge-v1", "tasks-v1"]) {
    namespaces.push(partitionPaths(await bindWorkspace(workspace, namespace, nextBudget())).directory);
  }
  return { kind: "bound", frozen: Object.isFrozen(binding), pathsFrozen: Object.isFrozen(paths), paths,
    expected: directory, second: partitionPaths(otherBinding).directory, unicode: partitionPaths(unicodeBinding).directory,
    linkedResult, traversal, alias, namespaces, ancestorsBefore, ancestorsAfter: ancestorInfo() };
}
async function missingCases() {
  const binding = await bind();
  const before = inventory(home);
  const inspect = await call("inspect-missing", (budget) => inspectPartition(binding, budget));
  const absentFile = await call("open-missing", (budget) => openPrivateFile(binding, "state.json", budget));
  return { inspect, absentFile, before, after: inventory(home) };
}
async function authorityCases() {
  const binding = await bind();
  const cases = [];
  for (const fake of [{}, { ...binding }, JSON.parse(JSON.stringify(binding)), { root: home, uid: process.getuid(), approval: true }]) {
    cases.push(await call("forged-paths", () => partitionPaths(fake)));
    cases.push(await call("forged-inspect", (budget) => inspectPartition(fake, budget)));
    cases.push(await call("forged-prepare", (budget) => preparePartition(fake, budget)));
    cases.push(await call("forged-open", (budget) => openPrivateFile(fake, "state.json", budget)));
  }
  for (const namespace of ["", "preferences-v1", "../memory-v1", { namespace: "memory-v1" }]) {
    cases.push(await call("bad-namespace", (budget) => bindWorkspace(workspace, namespace, budget)));
  }
  for (const input of ["", "bad\0path", { workspace, uid: process.getuid(), scope: "personal", approval: true }]) {
    cases.push(await call("bad-input", (budget) => bindWorkspace(input, "memory-v1", budget)));
  }
  for (const seam of [{ root: home }, { uid: process.getuid() }, { platform: "win32" }, { policy: "safe" }, { approval: true }]) {
    cases.push(await call("bad-seam", (budget) => bindWorkspace(workspace, "memory-v1", budget, seam)));
  }
  for (const name of ["../state.json", "/state.json", "state.json\0", { name: "state.json" }]) {
    cases.push(await call("bad-leaf", (budget) => openPrivateFile(binding, name, budget)));
  }
  for (const budget of [NaN, Infinity, {}, nextBudget() + 100_000]) {
    cases.push(await call("bad-budget", () => inspectPartition(binding, budget)));
  }
  cases.push(await call("expired-budget", () => inspectPartition(binding, performance.now() - 1)));
  const paths = await call("fixed-paths", () => partitionPaths(binding));
  return { cases, paths, privateInventory: inventory(folders[0]) };
}
async function prepareCases() {
  const binding = await bind();
  const before = inventory(home);
  const result = await call("prepare", (budget) => preparePartition(binding, budget));
  const after = inventory(home);
  const retried = await call("retry-prepare", (budget) => preparePartition(binding, budget));
  return { result, retried, before, after, folders,
    modes: folders.map((path) => lstatSync(path, { throwIfNoEntry: false })?.mode & 0o7777),
    stateExists: !!lstatSync(join(directory, "state.json"), { throwIfNoEntry: false }) };
}
async function directoryCases() {
  const binding = await bind();
  await mkdir(folders[0], { mode: 0o755 });
  await writeFile(join(folders[0], "canary"), "canary");
  const before = inventory(home);
  const broad = await call("broad-folder", (budget) => preparePartition(binding, budget));
  const after = inventory(home);
  await chmod(folders[0], 0o700);
  const wrongUid = await call("foreign-uid-folder", (budget) => preparePartition(binding, budget, { uid: () => process.getuid() + 1 }));
  const systemInfo = await lstat("/");
  const nativeUid = await call("native-system-uid", (budget) => inspectPartition(binding, budget, {
    open: (_path, flags) => open("/", flags),
  }));
  const special = [];
  for (const mode of [0o1700, 0o2700, 0o4700, 0o600, 0o500]) {
    await chmod(folders[0], mode);
    special.push(await call("folder-mode", (budget) => preparePartition(binding, budget)));
  }
  await rm(folders[0], { recursive: true });
  const linked = join(home, "linked-private");
  await mkdir(linked, { mode: 0o700 });
  await symlink(linked, folders[0]);
  const linkResult = await call("linked-folder", (budget) => inspectPartition(binding, budget));
  return { broad, wrongUid, nativeUid, systemUid: systemInfo.uid, currentUid: process.getuid(), before, after, special, linkResult };
}
async function prepareFaults() {
  const binding = await bind();
  const fault = Object.assign(new Error("fault"), { code: "EIO" });
  let once = true;
  const result = await call("mkdir-fault", (budget) => preparePartition(binding, budget, {
    mkdir: async (path, options) => {
      if (once) {
        once = false;
        throw fault;
      }
      return mkdir(path, options);
    },
  }));
  const retry = await call("mkdir-retry", (budget) => preparePartition(binding, budget));
  await rm(folders[0], { recursive: true });
  let created = false;
  const verify = await call("verify-fault", (budget) => preparePartition(binding, budget, {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      created = true;
    },
    open: async (path, flags) => {
      if (created) throw fault;
      return open(path, flags);
    },
  }));
  const retained = inventory(home);
  const verifyRetry = await call("verify-retry", (budget) => preparePartition(binding, budget));
  await rm(folders[0], { recursive: true });
  const eexist = await call("eexist", (budget) => preparePartition(binding, budget, {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      throw Object.assign(new Error("existing"), { code: "EEXIST" });
    },
  }));
  await rm(folders[0], { recursive: true });
  const hostileEexist = await call("hostile-eexist", (budget) => preparePartition(binding, budget, {
    mkdir: async (path) => {
      await mkdir(path, { mode: 0o755 });
      throw Object.assign(new Error("existing"), { code: "EEXIST" });
    },
  }));
  return { result, retry, verify, retained, verifyRetry, eexist, hostileEexist };
}
async function leafCases() {
  const binding = await ready();
  const state = join(directory, "state.json");
  const absent = await call("absent-state", (budget) => openPrivateFile(binding, "state.json", budget));
  const cases = [];
  for (const mode of [0o644, 0o400, 0o1600, 0o2600, 0o4600]) {
    await writeFile(state, "payload", { mode: 0o600 });
    await chmod(state, mode);
    const before = inventory(directory);
    const result = await call("leaf-mode", (budget) => openPrivateFile(binding, "state.json", budget));
    cases.push({ result, before, after: inventory(directory) });
    await rm(state);
  }
  await writeFile(state, "payload", { mode: 0o600 });
  let comparisons = 0;
  const wrongUid = await call("leaf-uid", (budget) => openPrivateFile(binding, "state.json", budget, {
    uid: () => process.getuid() + (++comparisons === 5 ? 1 : 0),
  }));
  const nativeForeign = await call("native-foreign-leaf", (budget) => openPrivateFile(binding, "state.json", budget, {
    open: (path, flags) => open(path === state ? "/" : path, flags),
  }));
  const hard = join(home, "hardlink");
  await link(state, hard);
  const hardlink = await call("hardlink", (budget) => openPrivateFile(binding, "state.json", budget));
  await rm(state);
  await symlink(hard, state);
  const linked = await call("leaf-link", (budget) => openPrivateFile(binding, "state.json", budget));
  await rm(state);
  await mkdir(state, { mode: 0o600 });
  const folder = await call("leaf-directory", (budget) => openPrivateFile(binding, "state.json", budget));
  await rm(state, { recursive: true });
  const child = spawn("mkfifo", ["-m", "600", state], { stdio: "ignore" });
  const [exit] = await once(child, "exit");
  if (exit !== 0) throw new Error("FIFO setup failed");
  const fifo = await call("leaf-fifo", (budget) => openPrivateFile(binding, "state.json", budget));
  return { absent, cases, wrongUid, nativeForeign, hardlink, linked, folder, fifo };
}
async function swapCases() {
  const binding = await ready();
  const state = join(directory, "state.json");
  const target = join(home, "target");
  await writeFile(state, "old", { mode: 0o600 });
  await writeFile(target, "target bytes", { mode: 0o600 });
  const before = inventory(home);
  let switched = false;
  const result = await call("swap", (budget) => openPrivateFile(binding, "state.json", budget, {
    open: async (path, flags) => {
      if (path === state && !switched) {
        switched = true;
        // The adversarial swap belongs to the fixture, not the admitted operation.
        setPhase();
        await rm(state);
        await symlink(target, state);
        setPhase("swap", budget);
      }
      return open(path, flags);
    },
  }));
  return { result, targetBytes: readFileSync(target).toString("hex"), before };
}
async function readCases() {
  const binding = await ready();
  const bytes = "abcdefghijklmnop";
  const state = join(directory, "state.json");
  await writeFile(state, bytes, { mode: 0o600 });
  const before = inventory(home);
  const counts = [];
  const short = await call("short", () => read(binding, 16, {
    read: async (handle, buffer) => {
      const result = await handle.read(buffer, 0, Math.min(5, buffer.length), null);
      counts.push(result.bytesRead);
      return result;
    },
  }));
  const caps = [];
  for (const cap of [15, 16, 17]) caps.push(await call("cap", () => read(binding, cap)));
  let interrupted = false;
  const eintr = await call("eintr", () => read(binding, 16, {
    read: async (handle, buffer) => {
      if (!interrupted) {
        interrupted = true;
        throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      }
      return handle.read(buffer, 0, Math.min(5, buffer.length), null);
    },
  }));
  let prefix = false;
  const midFault = await call("mid-fault", () => read(binding, 16, {
    read: async (handle, buffer) => {
      if (prefix) throw Object.assign(new Error("untrusted error data"), { code: "EIO" });
      prefix = true;
      return handle.read(buffer, 0, 5, null);
    },
  }));
  const retry = await call("read-retry", () => read(binding, 16));
  const openFault = await call("open-fault", (budget) => openPrivateFile(binding, "state.json", budget, {
    open: async () => { throw Object.assign(new Error("untrusted open data"), { code: "EIO" }); },
  }));
  const openRetry = await call("open-retry", () => read(binding, 16));
  const invalidCaps = [];
  for (const cap of [-1, 1.5, NaN, 16 * 1_024 * 1_024 + 1, { cap: 16 }]) {
    const result = await openPrivateFile(binding, "state.json", nextBudget());
    invalidCaps.push(await call("bad-cap", (budget) => readBounded(result.handle, cap, budget)));
    await result.handle.close();
  }
  const fakeHandle = await call("fake-handle", (budget) => readBounded({ read: () => "payload" }, 16, budget));
  await writeFile(state, "");
  const empty = await call("empty", () => read(binding, 0));
  await writeFile(state, bytes);
  return { short, counts, caps, eintr, midFault, retry, openFault, openRetry, invalidCaps, fakeHandle, empty,
    before, after: inventory(home), expected: Buffer.from(bytes).toString("hex") };
}
async function windowsCases() {
  const binding = await bind();
  const seam = { platform: () => "win32" };
  const cases = [];
  cases.push(await call("windows-bind", (budget) => bindWorkspace(workspace, "memory-v1", budget, seam)));
  cases.push(await call("windows-paths", () => partitionPaths(binding, seam)));
  cases.push(await call("windows-inspect", (budget) => inspectPartition(binding, budget, seam)));
  cases.push(await call("windows-prepare", (budget) => preparePartition(binding, budget, seam)));
  cases.push(await call("windows-open", (budget) => openPrivateFile(binding, "state.json", budget, seam)));
  cases.push(await call("windows-read", (budget) => readBounded({}, 16, budget, seam)));
  return { cases, native: process.platform === "win32" };
}
async function remoteCases() {
  const cases = [];
  for (const type of [0x6969, 0x517b, 0xff534d42, 0x65735546]) {
    cases.push(await call("remote-home", (budget) => bindWorkspace(workspace, "memory-v1", budget, {
      platform: () => "linux", statfs: async () => ({ type }),
    })));
  }
  const local = await call("local-home", (budget) => bindWorkspace(workspace, "memory-v1", budget, {
    platform: () => "linux", statfs: async () => ({ type: 0x1234 }),
  }));
  return { cases, local: local.code ?? "bound", actualType: Number((await statfs(home)).type), privateInventory: inventory(folders[0]) };
}
async function deadlineCases() {
  const binding = await ready();
  const state = join(directory, "state.json");
  await writeFile(state, "payload", { mode: 0o600 });
  const cases = [];
  // A virtual monotonic clock marks the awaited native operation as completing late.
  for (const operation of ["lstat", "realpath", "home-realpath", "statfs", "open", "leaf-open", "stat", "leaf-stat", "read", "close"]) {
    let now = 0;
    const seam = { clock: () => now };
    let action;
    if (["lstat", "realpath", "home-realpath", "statfs"].includes(operation)) {
      const method = operation === "home-realpath" ? "realpath" : operation;
      let calls = 0;
      seam[method] = async (...args) => observed(method, async () => {
        const value = await ({ lstat, realpath, statfs })[method](...args);
        if (operation !== "home-realpath" || ++calls === 2) now = 101;
        return value;
      });
      if (operation === "statfs") seam.platform = () => "linux";
      action = () => bindWorkspace(workspace, "memory-v1", 100, seam);
    } else if (operation === "read" || operation === "close") {
      const result = await openPrivateFile(binding, "state.json", nextBudget());
      if (operation === "read") seam.read = async (handle, buffer) => observed("read", async () => {
        const value = await handle.read(buffer, 0, buffer.length, null);
        now = 101;
        return value;
      });
      else {
        const close = result.handle.close.bind(result.handle);
        result.handle.close = async () => observed("close", async () => {
          await close();
          now = 101;
        });
      }
      action = () => readBounded(result.handle, 16, 100, seam);
    } else {
      seam.open = async (...args) => observed("open", async () => {
        const handle = await open(...args);
        if (operation === "open" || operation === "leaf-open") {
          if (operation === "open" || args[0] === state) now = 101;
        } else if (operation === "stat" || args[0] === state) {
          const stat = handle.stat.bind(handle);
          handle.stat = async () => observed("stat", async () => {
            const info = await stat();
            now = 101;
            return info;
          });
        }
        return handle;
      });
      action = () => operation.startsWith("leaf-") ? openPrivateFile(binding, "state.json", 100, seam) : inspectPartition(binding, 100, seam);
    }
    cases.push({ operation, result: await call("late-" + operation, action, 100, () => now) });
  }
  await rm(folders[0], { recursive: true });
  let now = 0;
  const mkdirLate = await call("late-mkdir", () => preparePartition(binding, 100, {
    clock: () => now,
    mkdir: async (path, options) => observed("mkdir", async () => {
      await mkdir(path, options);
      now = 101;
    }),
  }), 100, () => now);
  const retained = inventory(home);
  await rm(folders[0], { recursive: true });
  await preparePartition(binding, nextBudget());
  const child = spawn("mkfifo", ["-m", "600", state], { stdio: "ignore" });
  if ((await once(child, "exit"))[0] !== 0) throw new Error("FIFO setup failed");
  const writer = spawn(process.execPath, [resolve("tests/fixtures/private-store/admission/fifo-writer.mjs"), state], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writerDone = once(writer, "exit");
  await once(writer.stdout, "data");
  const start = performance.now();
  const deadline = start + 150;
  const fifo = await call("blocking-fifo", (budget) => openPrivateFile(binding, "state.json", budget, {
    flags: (flags) => flags & ~constants.O_NONBLOCK,
  }), deadline);
  const elapsed = performance.now() - start;
  const [writerExit] = await writerDone;
  return { cases, mkdirLate, retained, fifo, elapsed, writerExit };
}
async function inertCases() {
  const binding = await ready();
  const state = join(directory, "state.json");
  const text = JSON.stringify({ platform: "win32", uid: 0, policy: "safe", seam: "fetch('https://example.invalid')", approval: true });
  await writeFile(state, text, { mode: 0o600 });
  const bytes = await call("inert-bytes", () => read(binding, 1_024));
  const url = await call("inert-url", (budget) => bindWorkspace("https://example.invalid/run", "memory-v1", budget));
  const shape = await call("inert-shape", (budget) => bindWorkspace({ ...JSON.parse(text), workspace }, "memory-v1", budget));
  return { bytes, expected: Buffer.from(text).toString("hex"), url, shape };
}
const scenarios = {
  binding: bindingCases, missing: missingCases, authority: authorityCases, prepare: prepareCases,
  directories: directoryCases, prepareFaults, leaves: leafCases, swap: swapCases, reads: readCases,
  windows: windowsCases, remote: remoteCases, deadlines: deadlineCases, inert: inertCases,
};
try {
  const result = await scenarios[scenario]();
  await new Promise((done, reject) => process.stdout.write(JSON.stringify(result) + "\n", (error) => error ? reject(error) : done()));
} catch (error) {
  process.stderr.write("fixture failed: " + error.message + "\n");
  process.exitCode = 90;
}
