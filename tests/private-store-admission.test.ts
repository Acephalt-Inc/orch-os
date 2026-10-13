// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
interface Call {
  id: number;
  label: string;
  op: string;
  event: string;
  at: number;
  deadline: number;
  budgetTime: number;
  path: string;
  flags?: number;
  error?: string;
  identity?: { uid: number; mode: number; ino: number; nlink: number };
  bytes?: number;
}
const roots: string[] = [];
let counter = 0;
function restoreForCleanup(path: string) {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) restoreForCleanup(join(path, name));
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    restoreForCleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "private-admission-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  return { home, workspace };
}
function run(scenario: string, options: { home?: string; workspace?: string; umask?: string } = {}) {
  const made = setup();
  const home = options.home ?? made.home;
  const workspace = options.workspace ?? made.workspace;
  const log = join(dirname(made.home), "trace.jsonl");
  const fixture = resolve("tests/fixtures/private-store/admission/probe.mjs");
  const preload = pathToFileURL(resolve("tests/fixtures/private-store/admission/trace.mjs")).href;
  const args = ["--import", preload];
  if (options.umask) {
    args.push("--input-type=module", "-e",
      `process.umask(parseInt(process.argv[1], 8));
await import(process.argv[2]);`, options.umask, pathToFileURL(fixture).href,
      workspace, scenario);
    // The inline launcher supplies a normal fixture argv, without a global environment assignment.
    args[args.indexOf("-e") + 1] = "process.umask(parseInt(process.argv[1], 8));\n"
      + "const fixture = process.argv[2];\n"
      + "process.argv = [process.argv[0], fixture, ...process.argv.slice(3)];\n"
      + "await import(fixture);";
  } else args.push(fixture, workspace, scenario);
  const child = spawnSync(process.execPath, args, {
    env: { ...process.env, HOME: home, USERPROFILE: home, ORCH_HOME: join(made.home, "ignored"),
      ADMISSION_TRACE: log, PRIVATE_STORE_PLATFORM: "win32", PRIVATE_STORE_UID: "0", PRIVATE_STORE_FAULT: "safe" },
    encoding: "utf8", timeout: 15_000,
  });
  const trace = readFileSync(log, "utf8");
  mkdirSync("dist/private-store-traces", { recursive: true });
  writeFileSync(join("dist/private-store-traces", `${scenario}-${options.umask ?? "default"}-${counter++}.jsonl`), trace);
  expect(child.error, "fixture launch error").toBeUndefined();
  expect(child.signal, "fixture timed out").toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
  const calls: Call[] = trace.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result: JSON.parse(child.stdout), calls, home, workspace };
}
const submissions = (calls: Call[]) => calls.filter((call) => call.event === "submit");
function writes(calls: Call[]) {
  return submissions(calls).filter((call) => !call.op.startsWith("seam.")).filter((call) =>
    /mkdir|rmdir|\.rm|unlink|rename|link|chmod|chown|truncate|write|append|copy|\.cp/.test(call.op)
    || (/open/.test(call.op) && ((call.flags ?? 0) & (constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_RDWR)) !== 0));
}
const contentReads = (calls: Call[]) => submissions(calls).filter((call) => /handle\.read|fs\.readFile/.test(call.op));
function noExternal(calls: Call[]) {
  expect(submissions(calls).filter((call) => /^(child_process|net|http|https|dns|worker_threads|fetch)/.test(call.op))).toEqual([]);
}
function fixedFailure(value: any, code: string) {
  expect(value).toEqual({ code, message: "private storage request refused" });
}
it("inspect_missing_is_noncreating", () => {
  const { result, calls } = run("missing");
  // K1.01
  expect(result.inspect).toEqual({ value: { kind: "absent" } });
  expect(result.absentFile).toEqual({ value: { kind: "absent" } });
  expect(writes(calls)).toEqual([]);
  expect(contentReads(calls)).toEqual([]);
  expect(result.after).toEqual(result.before);
});
it("binding_uses_canonical_workspace_and_fixed_namespace", () => {
  const { result, calls } = run("binding");
  // K1.02
  expect(result).toMatchObject({ kind: "bound", frozen: true, pathsFrozen: true });
  expect(result.paths.directory).toBe(result.expected);
  expect(result.paths.state).toBe(join(result.paths.directory, "state.json"));
  expect(result.paths.lock).toBe(join(result.paths.directory, ".lock"));
  expect(result.second).not.toBe(result.paths.directory);
  expect(result.unicode).not.toBe(result.paths.directory);
  fixedFailure(result.linkedResult, "BAD_BINDING");
  fixedFailure(result.traversal, "BAD_BINDING");
  fixedFailure(result.fileWorkspace, "BAD_BINDING");
  expect(submissions(calls).filter((call) => call.label.startsWith("linked-") && /open|realpath|mkdir/.test(call.op))).toEqual([]);
  expect(writes(calls)).toEqual([]);
  expect(result.namespaces).toEqual(["memory-v1", "knowledge-v1", "tasks-v1"].map((namespace) =>
    result.paths.directory.replace("memory-v1", namespace)));
  if (result.alias.skip) expect(result.alias.skip).toBe("realpath aliases do not exist on this case-sensitive volume");
  else {
    expect(result.alias.same).toBe(true);
    expect(result.alias.digests[0]).toBe(result.alias.digests[1]);
    expect(result.alias.bound).toEqual(Array(2).fill(join(dirname(result.paths.directory), result.alias.digests[0])));
  }
  expect(result.ancestorsAfter).toEqual(result.ancestorsBefore);
  const made = setup();
  const alias = join(made.home, "home-alias");
  symlinkSync(made.home, alias);
  const before = lstatSync(made.home);
  const linkedHome = run("binding", { home: alias, workspace: made.workspace });
  expect(linkedHome.result.paths.directory).toBe(linkedHome.result.expected);
  expect(writes(linkedHome.calls)).toEqual([]);
  const after = lstatSync(made.home);
  expect([after.mode, after.ino, after.uid]).toEqual([before.mode, before.ino, before.uid]);
  expect(linkedHome.result.ancestorsAfter).toEqual(linkedHome.result.ancestorsBefore);
});
it("outside_values_cannot_select_store_authority", () => {
  const { result, calls, home } = run("authority");
  // K1.03
  fixedFailure(result.rawSeam, "IO_UNAVAILABLE");
  expect.soft(result.augmentedSeam, "augmented-seam").toEqual({
    code: "IO_UNAVAILABLE", message: "private storage request refused", same: false });
  expect.soft(result.accessorSeam, "accessor-seam").toEqual({
    code: "IO_UNAVAILABLE", message: "private storage request refused" });
  for (const value of result.cases.slice(0, 16)) fixedFailure(value, "BAD_BINDING");
  for (const value of result.cases.slice(16, -1)) fixedFailure(value, "BAD_INPUT");
  fixedFailure(result.cases.at(-1), "DEADLINE");
  expect(submissions(calls).filter((call) => call.label !== "fixed-paths")).toEqual([]);
  expect(result.paths.value.directory).toContain(join(home, ".orch-private", "memory-v1", "personal"));
  expect(submissions(calls).filter((call) => call.path?.includes("ignored"))).toEqual([]);
  expect(result.privateInventory).toEqual([]);
});
it("posix_directory_admission_checks_opened_object", () => {
  // K1.04
  for (const umask of ["022", "0277"]) {
    const { result, calls } = run("prepare", { umask });
    const first = calls.filter((call) => call.label === "prepare");
    for (const call of submissions(first).filter((call) => call.op === "fs.promises.open")) {
      expect(call.flags! & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY);
    }
    const mk = submissions(first).filter((call) => call.op === "fs.promises.mkdir");
    const completed = first.filter((call) => call.op === "fs.promises.mkdir" && call.event === "complete");
    expect(mk.map((call) => call.path)).toEqual(umask === "022" ? result.folders : result.folders.slice(0, 1));
    expect(completed).toHaveLength(mk.length);
    expect(completed.every((call) => !call.error)).toBe(true);
    expect(writes(first).map((call) => call.op)).toEqual(mk.map(() => "fs.promises.mkdir"));
    expect(result.stateExists).toBe(false);
    if (umask === "022") {
      expect(result.result).toEqual({ value: { kind: "present" } });
      expect(result.retried).toEqual({ value: { kind: "present" } });
      expect(result.modes).toEqual([0o700, 0o700, 0o700, 0o700]);
      expect(result.after.filter((entry: any) => entry.name.startsWith(".orch-private"))
        .map((entry: any) => [entry.type, entry.mode])).toEqual(Array(4).fill(["directory", 0o700]));
    } else {
      fixedFailure(result.result, "UNSAFE_PATH");
      fixedFailure(result.retried, "UNSAFE_PATH");
      expect(result.modes[0]).toBe(0o500);
      const created = result.after.filter((entry: any) => entry.name.startsWith(".orch-private"));
      expect(created.map((entry: any) => [entry.name, entry.type, entry.mode])).toEqual([[".orch-private", "directory", 0o500]]);
      expect(writes(calls).map((call) => call.op)).toEqual(["fs.promises.mkdir"]);
    }
  }
  const { result, calls } = run("directories");
  for (const key of ["broad", "wrongUid", "nativeUid", "linkResult"]) fixedFailure(result[key], "UNSAFE_PATH");
  for (const value of result.special) {
    if (value.notObservable) {
      console.log(`K1.04/directory-special-mode-${value.mode.toString(8)} NOT OBSERVABLE: chmod requested ${value.mode.toString(8)}, `
        + `but read-back was ${value.observedMode.toString(8)} on this platform; refusal for the missing bit is not verified.`);
      continue;
    }
    expect(value.observedMode).toBe(value.mode);
    fixedFailure(value.result, "UNSAFE_PATH");
  }
  expect(result.systemUid).toBe(0);
  expect(result.currentUid).not.toBe(0);
  expect(result.after).toEqual(result.before);
  expect(writes(calls)).toEqual([]);
  expect(contentReads(calls)).toEqual([]);
  const native = calls.filter((call) => call.label === "native-system-uid");
  expect(submissions(native).filter((call) => call.op === "fs.promises.open").map((call) => call.path)).toEqual(["/"]);
  expect(native.find((call) => call.op === "handle.stat" && call.event === "complete")?.identity?.uid).toBe(0);
  const faults = run("prepareFaults");
  fixedFailure(faults.result.result, "IO_UNAVAILABLE");
  fixedFailure(faults.result.verify, "IO_UNAVAILABLE");
  for (const key of ["retry", "verifyRetry", "eexist"]) expect(faults.result[key]).toEqual({ value: { kind: "present" } });
  fixedFailure(faults.result.hostileEexist, "UNSAFE_PATH");
  expect(faults.result.retained.filter((entry: any) => entry.name.startsWith(".orch-private"))
    .map((entry: any) => [entry.name, entry.mode])).toEqual([[".orch-private", 0o700]]);
  const verifyCalls = faults.calls.filter((call) => call.label === "verify-fault");
  expect(writes(verifyCalls).map((call) => call.op)).toEqual(["fs.promises.mkdir"]);
});
it("posix_leaf_admission_precedes_content_read", () => {
  const { result, calls } = run("leaves");
  // K1.05
  expect(result.absent).toEqual({ value: { kind: "absent" } });
  for (const value of result.cases) {
    if (value.notObservable) {
      // K1.05: additional special-bit probe, not an admission pass or failure.
      console.log(`K1.05/special-mode-${value.mode.toString(8)} NOT OBSERVABLE: chmod requested ${value.mode.toString(8)}, `
        + `but read-back was ${value.observedMode.toString(8)} on this platform; refusal for the missing bit is not verified.`);
      continue;
    }
    expect(value.observedMode).toBe(value.mode);
    fixedFailure(value.result, "UNSAFE_PATH");
    expect(value.after).toEqual(value.before);
  }
  for (const key of ["wrongUid", "nativeForeign", "hardlink", "linked", "folder", "fifo"]) {
    fixedFailure(result[key], "UNSAFE_PATH");
  }
  expect(contentReads(calls)).toEqual([]);
  expect(writes(calls)).toEqual([]);
  for (const call of submissions(calls).filter((call) => call.op === "fs.promises.open")) {
    expect(call.flags! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(call.flags! & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  }
});
it("posix_final_leaf_swap_is_refused", () => {
  const { result, calls } = run("swap");
  // K1.06
  fixedFailure(result.result, "UNSAFE_PATH");
  expect(result.targetBytes).toBe(Buffer.from("target bytes").toString("hex"));
  expect(contentReads(calls)).toEqual([]);
  expect(writes(calls)).toEqual([]);
  expect(submissions(calls).filter((call) => call.path.endsWith("/target"))).toEqual([]);
});
it("bounded_read_loops_and_faults", () => {
  const { result, calls } = run("reads");
  // K1.09
  expect(result.short).toEqual({ value: { bytes: result.expected } });
  expect(result.counts).toEqual([5, 5, 5, 1, 0]);
  fixedFailure(result.caps[0], "TOO_LARGE");
  for (const value of result.caps.slice(1)) expect(value).toEqual({ value: { bytes: result.expected } });
  for (const key of ["eintr", "retry", "openRetry"]) expect(result[key]).toEqual({ value: { bytes: result.expected } });
  for (const key of ["midFault", "openFault"]) fixedFailure(result[key], "IO_UNAVAILABLE");
  for (const value of result.invalidCaps) fixedFailure(value, "BAD_INPUT");
  fixedFailure(result.fakeHandle, "BAD_BINDING");
  fixedFailure(result.repeat, "BAD_BINDING");
  expect(result.empty).toEqual({ value: { bytes: "" } });
  expect(result.after).toEqual(result.before);
  expect(writes(calls)).toEqual([]);
  const fault = calls.filter((call) => call.label === "mid-fault");
  expect(fault.filter((call) => call.op === "handle.read" && call.event === "complete").map((call) => call.bytes)).toEqual([5]);
  expect(submissions(fault).filter((call) => call.op === "handle.close")).toHaveLength(5);
});
it("late_admission_cannot_start_next_io", () => {
  const { result, calls } = run("deadlines");
  // K1.10
  for (const entry of result.lateCloses) {
    expect.soft(entry.result, "late-" + entry.operation).toEqual({ code: "DEADLINE", message: "private storage request refused" });
    if (entry.closeCalls !== undefined) expect.soft(entry.closeCalls, entry.operation).toBe(1);
    if (entry.closeCalls !== undefined) continue;
    const phase = calls.filter((call) => call.label === "late-" + entry.operation);
    const closed = phase.find((call) => call.op === "seam.close" && call.event === "complete")!;
    expect(submissions(phase).filter((call) => call.at > closed.at)).toEqual([]);
  }
  for (const entry of result.cases) fixedFailure(entry.result, "DEADLINE");
  fixedFailure(result.mkdirLate, "DEADLINE");
  fixedFailure(result.fifo, "DEADLINE");
  fixedFailure(result.betweenAwaits, "DEADLINE");
  fixedFailure(result.lateRejection, "DEADLINE");
  const between = calls.filter((call) => call.label === "between-awaits");
  expect(submissions(between).map((call) => call.op)).toEqual(["fs.promises.open", "handle.stat", "handle.close"]);
  expect(result.elapsed).toBeGreaterThanOrEqual(300);
  expect(result.writerExit).toBe(0);
  const fifo = calls.filter((call) => call.label === "blocking-fifo");
  const leaf = fifo.find((call) => call.op === "fs.promises.open" && call.event === "submit" && call.path.endsWith("state.json"))!;
  expect(leaf.flags! & constants.O_NONBLOCK).toBe(0);
  const complete = fifo.find((call) => call.id === leaf.id && call.event === "complete")!;
  expect(leaf.at).toBeLessThan(leaf.deadline);
  expect(complete.at).toBeGreaterThan(leaf.deadline);
  expect(submissions(fifo).filter((call) => call.at > complete.at).map((call) => call.op)).toEqual(["handle.close"]);
  const mkdirCalls = calls.filter((call) => call.label === "late-mkdir");
  expect(writes(mkdirCalls).map((call) => call.op)).toEqual(["fs.promises.mkdir"]);
  const mkdirComplete = mkdirCalls.find((call) => call.op === "fs.promises.mkdir" && call.event === "complete")!;
  expect(submissions(mkdirCalls).filter((call) => call.at > mkdirComplete.at)).toEqual([]);
  expect(result.retained.filter((entry: any) => entry.name.startsWith(".orch-private"))
    .map((entry: any) => [entry.name, entry.type, entry.mode])).toEqual([[".orch-private", "directory", 0o700]]);
  for (const entry of result.cases) {
    const phase = calls.filter((call) => call.label === "late-" + entry.operation);
    const late = phase.find((call) => call.event === "complete" && call.budgetTime >= 100)!;
    expect(late, entry.operation).toBeDefined();
    expect(submissions(phase).filter((call) => call.at > late.at).every((call) => call.op === "handle.close")).toBe(true);
    if (["open", "leaf-open", "stat", "leaf-stat", "read"].includes(entry.operation)) {
      expect(submissions(phase).filter((call) => call.at > late.at && call.op === "handle.close")).toHaveLength(1);
    }
  }
});
it("windows_private_access_is_unavailable", () => {
  const { result, calls } = run("windows");
  // K1.11: platform-function control only; native Windows evidence is separate.
  for (const value of result.cases) fixedFailure(value, "PRIVACY_UNAVAILABLE");
  expect(submissions(calls)).toEqual([]);
  expect(result.native).toBe(false);
});
it("identified_linux_remote_home_matrix", () => {
  const { result, calls } = run("remote");
  // K1.02: recognized identifiers, not a native remote-mount acceptance.
  for (const value of result.cases) fixedFailure(value, "PRIVACY_UNAVAILABLE");
  expect(result.local).toBe("bound");
  expect(result.privateInventory).toEqual([]);
  expect(writes(calls)).toEqual([]);
});
const publicSentences = [
  "Inspecting a missing private partition creates no folder or state file.",
  "A private partition is selected by trusted code from the user home, a fixed namespace and the canonical workspace path; ORCH_HOME does not select it.",
  "Resolve the home with realpath (as src/preferences/store.ts:67 does); components above .orch-private are observed but a link " +
  "there does not refuse; from .orch-private through the partition an observed link refuses.",
  "A program that can replace a private-store folder between the last safety check and a filesystem operation is not defended against.",
  "Such a replacement can redirect that operation outside the private-store folder.",
  "This local store does not defend against a program running under the user's account or as an administrator.",
  "readBounded retries a read that reports EINTR; this case is exercised only through the test seam because the platform does not deliver it for local files.",
  "New folders are created with mode 0700 under the process umask; if a folder this call created is not observed as exactly 0700, " +
  "prepare refuses it and does not change its mode.",
  "The library checks that the private folders and state file are owned by the current user with owner-only permission bits; it does " +
  "not read access-control lists, so an entry granting another user access is not detected.",
  "The five-second budget prevents the library from starting its next I/O step after expiry; an OS operation submitted earlier may " +
  "finish later, and the call returns only after it has.",
  "The library returns results to its caller and does not print a report.",
  "The macOS checks inspect observed ownership, permission bits and file types; they do not establish protection against folder " +
  "replacement or detect each remote or cloud-synced home.",
  "The Linux checks refuse identified remote home filesystems; unidentified remote and cloud-synced homes have not been verified.",
  "Windows private-store access is unavailable in this version because its native privacy adapter has not been verified.",
];
it("admission_public_text_matches_entry_matrix", async () => {
  // K1.12
  const doc = readFileSync("docs/private-store.md", "utf8");
  for (const sentence of publicSentences) expect(doc).toContain(sentence);
  expect(doc).not.toContain("memory is unavailable on Windows in this version");
  expect(doc).not.toContain("Input is limited by UTF-8 bytes and decoded with strict JSON");
  const inert = run("inert");
  noExternal(inert.calls);
  expect(inert.result.bytes).toEqual({ value: { bytes: inert.result.expected } });
  fixedFailure(inert.result.shape, "BAD_INPUT");
  fixedFailure(inert.result.url, "IO_UNAVAILABLE");
  noExternal(inert.calls);
  expect(writes(inert.calls)).toEqual([]);
  for (const scenario of ["missing", "authority", "windows", "reads"]) {
    const probe = run(scenario);
    noExternal(probe.calls);
  }
  const report = resolve("tests/fixtures/private-store/admission/report.mjs");
  const intact = spawnSync(process.execPath, [report], { encoding: "utf8", timeout: 10_000 });
  expect(intact.status).toBe(0);
  expect(intact.stderr).toBe("");
  expect(intact.stdout.startsWith('{"code":"BAD_INPUT","message":"private storage request refused"}\n')).toBe(true);
  const child = spawn(process.execPath, [report, "pause"], { stdio: ["pipe", "pipe", "pipe"] });
  const completed = once(child, "exit");
  let prefix = Buffer.alloc(0);
  let diagnostic = "";
  const accepted = new Promise<void>((done) => {
    child.stdout.on("data", (bytes) => {
      prefix = Buffer.concat([prefix, bytes]);
      if (prefix.length >= 100) done();
    });
  });
  const first = new Promise<void>((done) => {
    child.stderr.on("data", (bytes) => {
      diagnostic += bytes;
      if (diagnostic.includes("first 100 delivered")) done();
    });
  });
  await Promise.all([first, accepted]);
  expect(prefix.length).toBe(100);
  child.stdout.destroy();
  await once(child.stdout, "close");
  child.stdin.end("resume\n");
  const [exit] = await completed;
  expect(exit).toBe(74);
  expect(diagnostic).toContain("output failed");
  expect(prefix.length).toBe(100);
});
