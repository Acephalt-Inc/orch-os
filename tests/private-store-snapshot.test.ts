import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindWorkspace, partitionPaths } from "../src/private-store/binding.js";
import { preparePartition } from "../src/private-store/privacy.js";
import { commitSnapshot, mutateSnapshot, readSnapshot, recoverSnapshot, type SnapshotCodec } from "../src/private-store/snapshot.js";

const homes: string[] = [];
const codec: SnapshotCodec<{ text: string }> = {
  decode(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "text" || typeof (value as { text: unknown }).text !== "string") {
      throw new Error("invalid payload");
    }
    return { text: (value as { text: string }).text };
  },
  encode(value) { return value; },
};
async function fixture() {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "snapshot-"));
  homes.push(workspace);
  const deadline = performance.now() + 5_000;
  const binding = await bindWorkspace(workspace, "memory-v1", deadline);
  return { workspace, deadline, binding, paths: partitionPaths(binding) };
}
afterEach(() => {
  for (const path of homes) rmSync(path, { recursive: true, force: true });
});

it("snapshot_survives_process_restart", async () => {
  const { workspace, deadline, binding, paths } = await fixture();
  const written = await commitSnapshot(binding, codec, 0, { text: "whole value" }, deadline);
  // K2.02: The first commit installs exactly generation one.
  expect(written).toMatchObject({ status: "written", generation: 1, durability: "synced",
    inventoryVerified: true, lockReleased: true, warnings: [] });
  expect(existsSync(paths.state)).toBe(true);
  const envelope = JSON.parse(readFileSync(paths.state, "utf8"));
  expect(envelope).toMatchObject({ format: 1, generation: 1, payload: { text: "whole value" } });
  const child = execFileSync(process.execPath, [new URL("./fixtures/private-store/snapshot/read.mjs", import.meta.url).pathname, workspace],
    { encoding: "utf8" });
  // K2.02: A fresh process reads the same complete payload from the fixed partition.
  expect(JSON.parse(child)).toEqual({ status: "read", generation: 1, value: { text: "whole value" } });
});

it("snapshot_envelope_and_codec_are_closed", async () => {
  const { deadline, binding, paths } = await fixture();
  await commitSnapshot(binding, codec, 0, { text: "valid" }, deadline);
  const good = JSON.parse(readFileSync(paths.state, "utf8"));
  for (const bad of [
    { ...good, format: 2 }, { ...good, generation: 0 }, { ...good, workspaceDigest: "0".repeat(64) },
    { ...good, payload: { text: "valid", extra: 1 } }, { ...good, extra: true },
  ]) {
    const bytes = Buffer.from(JSON.stringify(bad) + "\n");
    writeFileSync(paths.state, bytes);
    // K2.03: A malformed committed envelope never becomes empty state or is overwritten.
    await expect(readSnapshot(binding, codec, deadline)).rejects.toMatchObject({ code: "CORRUPT_STATE" });
    await expect(commitSnapshot(binding, codec, 1, { text: "replacement" }, deadline)).rejects.toMatchObject({ code: "CORRUPT_STATE" });
    expect(readFileSync(paths.state).equals(bytes)).toBe(true);
  }
});

it("snapshot_readers_and_writers_share_one_mutex", async () => {
  const { binding } = await fixture();
  const deadline = performance.now() + 5_000;
  const contenders = await Promise.allSettled([
    commitSnapshot(binding, codec, 0, { text: "first" }, deadline),
    commitSnapshot(binding, codec, 0, { text: "second" }, deadline),
  ]);
  // K2.04: Two same-generation writers install one generation and one conflict.
  expect(contenders.filter((reply) => reply.status === "fulfilled")).toHaveLength(1);
  expect(contenders.filter((reply) => reply.status === "rejected" && reply.reason.code === "CONFLICT")).toHaveLength(1);
  const committed = await readSnapshot(binding, codec, performance.now() + 5_000, (value) => value);
  // K2.04: Readers see a whole committed payload at generation one.
  expect(committed).toMatchObject({ status: "read", generation: 1 });
  if (committed.status !== "read") throw new Error("missing committed state");
  expect(["first", "second"]).toContain(JSON.parse(committed.output.toString()).text);

  let atFileSync!: () => void;
  let releaseSync!: () => void;
  const arrived = new Promise<void>((resolve) => { atFileSync = resolve; });
  const paused = new Promise<void>((resolve) => { releaseSync = resolve; });
  const writer = mutateSnapshot(binding, codec, 1, performance.now() + 5_000,
    (value) => ({ text: `${value?.text}-next` }), {
      async sync(handle) {
        if ((await handle.stat()).isFile()) { atFileSync(); await paused; }
        await handle.sync();
      },
    });
  await arrived;
  // K2.04: A reader cannot bypass the writer's held lock at the temp-flushed barrier.
  try {
    await expect(readSnapshot(binding, codec, performance.now() + 5_000, (value) => value))
      .rejects.toMatchObject({ code: "LOCK_HELD" });
  } finally { releaseSync(); }
  expect(await writer).toMatchObject({ status: "written", generation: 2 });
  expect(await readSnapshot(binding, codec, performance.now() + 5_000, (value) => value))
    .toMatchObject({ status: "read", generation: 2 });

  const separate = await fixture();
  const program = new URL("./fixtures/private-store/snapshot/race.mjs", import.meta.url).pathname;
  const launch = (text: string) => {
    const child = spawn(process.execPath, [program, separate.workspace, text], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => { if (output.includes("READY\n")) resolve(); });
      child.once("error", reject);
      child.once("close", () => { if (!output.includes("READY\n")) reject(new Error(errors)); });
    });
    const done = new Promise<{ status?: string; generation?: number; code?: string }>((resolve, reject) => {
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(errors || `racer exit ${code}`));
        else resolve(JSON.parse(output.trim().split("\n").at(-1)!));
      });
    });
    void done.catch(() => undefined);
    return { child, ready, done };
  };
  const first = launch("process-first");
  const second = launch("process-second");
  await Promise.all([first.ready, second.ready]);
  first.child.stdin.end("go\n");
  second.child.stdin.end("go\n");
  const outcomes = await Promise.all([first.done, second.done]);
  // K2.04: Two real processes released from one barrier install one generation and one conflict.
  expect(outcomes.map((reply) => reply.status ?? reply.code).sort()).toEqual(["CONFLICT", "written"]);
  expect(JSON.parse(readFileSync(separate.paths.state, "utf8")).generation).toBe(1);
  console.log(JSON.stringify({ racePids: [first.child.pid, second.child.pid], outcomes }));
}, 15_000);

it("snapshot_lock_is_bounded_and_not_stolen", async () => {
  const { binding, paths } = await fixture();
  await preparePartition(binding, performance.now() + 5_000);
  mkdirSync(paths.lock, { mode: 0o700 });
  const inode = statSync(paths.lock).ino;
  // K2.05: Read, commit and recovery report a held lock without removing its inode.
  for (const operation of [
    () => readSnapshot(binding, codec, performance.now() + 5_000),
    () => commitSnapshot(binding, codec, 0, { text: "blocked" }, performance.now() + 5_000),
    () => recoverSnapshot(binding, codec, performance.now() + 5_000),
  ]) {
    await expect(operation()).rejects.toMatchObject({ code: "LOCK_HELD" });
    expect(statSync(paths.lock).ino).toBe(inode);
    expect(existsSync(paths.state)).toBe(false);
  }
  // K2.05: An overall deadline can end the wait without a late state write.
  await expect(readSnapshot(binding, codec, performance.now() + 100))
    .rejects.toMatchObject({ code: "DEADLINE" });
  expect(statSync(paths.lock).ino).toBe(inode);
  rmdirSync(paths.lock);
  const trace: string[] = [];
  await expect(commitSnapshot(binding, codec, 0, { text: "late lock" }, performance.now() + 15, {
    async mkdir(path, options) {
      trace.push(`mkdir:${path}`);
      await mkdir(path, options);
      if (path === paths.lock) await new Promise((resolve) => setTimeout(resolve, 40));
    },
    async lstat(path) {
      trace.push(`lstat:${path}`);
      return lstat(path);
    },
  })).rejects.toMatchObject({ code: "DEADLINE", lockReleased: false, warnings: ["LOCK_LEFT"] });
  // K2.05: A late successful lock creation is retained and no identity probe starts after expiry.
  expect(existsSync(paths.lock)).toBe(true);
  expect(trace.filter((entry) => entry === `lstat:${paths.lock}`)).toEqual([]);
  expect(existsSync(paths.state)).toBe(false);

  const identity = await fixture();
  await preparePartition(identity.binding, performance.now() + 5_000);
  await expect(readSnapshot(identity.binding, codec, performance.now() + 25, undefined, {
    async lstat(path) {
      const info = await lstat(path);
      if (path === identity.paths.lock) await new Promise((resolve) => setTimeout(resolve, 60));
      return info;
    },
  })).rejects.toMatchObject({ code: "DEADLINE", lockReleased: false, warnings: ["LOCK_LEFT"] });
  // K2.05: A late lock identity observation leaves the known created lock reported as retained.
  expect(existsSync(identity.paths.lock)).toBe(true);
}, 12_000);

it("snapshot_caps_and_generation_overflow", async () => {
  const max = 16 * 1024 * 1024;
  const chunks = Array(83).fill("a".repeat(200_000)) as string[];
  const arrayCodec: SnapshotCodec<string[]> = {
    decode(value) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid chunks");
      return value as string[];
    },
    encode(value) { return value; },
  };
  const large = await fixture();
  function exact(target: number): string[] {
    const sample = { format: 1, namespace: "memory-v1", workspaceDigest: basename(large.paths.directory),
      generation: 1, committedAt: "2026-10-14T00:00:00.000Z", payload: [...chunks, ""] };
    const tail = target - Buffer.byteLength(JSON.stringify(sample) + "\n");
    expect(tail).toBeGreaterThan(0);
    expect(tail).toBeLessThan(256 * 1024);
    return [...chunks, "b".repeat(tail)];
  }
  const cap = exact(max);
  const short = exact(max - 1);
  const over = exact(max + 1);
  // K2.06: The state cap admits cap−1 and cap and refuses cap+1 without replacement.
  const small = await fixture();
  expect(await commitSnapshot(small.binding, arrayCodec, 0, short, performance.now() + 5_000))
    .toMatchObject({ status: "written", generation: 1 });
  expect(readFileSync(small.paths.state).length).toBe(max - 1);
  await expect(commitSnapshot(large.binding, arrayCodec, 0, cap, performance.now() + 5_000))
    .resolves.toMatchObject({ status: "written", generation: 1 });
  expect(readFileSync(large.paths.state).length).toBe(max);
  expect(await commitSnapshot(large.binding, arrayCodec, 1, cap, performance.now() + 5_000))
    .toMatchObject({ status: "written", generation: 2 });
  expect(readFileSync(large.paths.state).length).toBe(max);
  const before = readFileSync(large.paths.state);
  await expect(commitSnapshot(large.binding, arrayCodec, 2, over, performance.now() + 5_000))
    .rejects.toMatchObject({ code: "TOO_LARGE" });
  expect(readFileSync(large.paths.state).equals(before)).toBe(true);

  const output = await fixture();
  await commitSnapshot(output.binding, codec, 0, { text: "small" }, performance.now() + 5_000);
  // K2.06: Complete framed output at 64 KiB passes; one byte beyond refuses without output.
  const atCap = await readSnapshot(output.binding, codec, performance.now() + 5_000, () => "x".repeat(64 * 1024 - 3));
  expect(atCap.status).toBe("read");
  if (atCap.status !== "read") throw new Error("missing output");
  expect(atCap.output.length).toBe(64 * 1024);
  await expect(readSnapshot(output.binding, codec, performance.now() + 5_000, () => "x".repeat(64 * 1024 - 2)))
    .rejects.toMatchObject({ code: "TOO_LARGE" });

  const overflow = await fixture();
  await commitSnapshot(overflow.binding, codec, 0, { text: "old" }, performance.now() + 5_000);
  const envelope = JSON.parse(readFileSync(overflow.paths.state, "utf8"));
  writeFileSync(overflow.paths.state, JSON.stringify({ ...envelope, generation: Number.MAX_SAFE_INTEGER }) + "\n");
  // K2.06: Generation overflow refuses with the canonical bytes unchanged.
  const overflowBytes = readFileSync(overflow.paths.state);
  let overflowReducerCalled = false;
  await expect(mutateSnapshot(overflow.binding, codec, Number.MAX_SAFE_INTEGER, performance.now() + 5_000,
    () => { overflowReducerCalled = true; return { text: "new" }; })).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(overflowReducerCalled).toBe(false);
  expect(readFileSync(overflow.paths.state).equals(overflowBytes)).toBe(true);

  const quota = large;
  const first = join(quota.paths.directory, `.state-${"1".repeat(36)}.tmp`);
  const second = join(quota.paths.directory, `.state-${"2".repeat(36)}.tmp`);
  writeFileSync(first, Buffer.alloc(8 * 1024 * 1024), { mode: 0o600 });
  writeFileSync(second, Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 });
  // K2.06: Managed bytes at 32 MiB + 1 refuse before explicit cleanup.
  await expect(recoverSnapshot(quota.binding, arrayCodec, performance.now() + 5_000))
    .rejects.toMatchObject({ code: "TOO_LARGE" });
  expect(existsSync(first) && existsSync(second)).toBe(true);
  writeFileSync(second, Buffer.alloc(8 * 1024 * 1024), { mode: 0o600 });
  expect(await recoverSnapshot(quota.binding, arrayCodec, performance.now() + 5_000))
    .toMatchObject({ status: "recovered", generation: 2, discardedTemps: 2 });

  const entries = await fixture();
  await preparePartition(entries.binding, performance.now() + 5_000);
  for (let i = 0; i < 32; i++) {
    writeFileSync(join(entries.paths.directory, `.state-${String(i).padStart(36, "0")}.tmp`), "x", { mode: 0o600 });
  }
  // K2.06: Entry 33 refuses without deleting any recognized temp.
  await expect(recoverSnapshot(entries.binding, codec, performance.now() + 5_000))
    .rejects.toMatchObject({ code: "TOO_LARGE" });
  expect(readdirSync(entries.paths.directory)).toHaveLength(32);
}, 30_000);

it("snapshot_absence_and_invalid_input_do_not_create", async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "snapshot-"));
  homes.push(workspace);
  const deadline = performance.now() + 5_000;
  const binding = await bindWorkspace(workspace, "memory-v1", deadline);
  const result = await readSnapshot(binding, {
    decode(value: unknown) { return value; },
    encode(value: unknown) { return value; },
  }, deadline);
  // K2.01: A missing partition is a zero-generation absence.
  expect(result).toEqual({ status: "absent", generation: 0 });
  // K2.01: The read must not prepare managed folders.
  expect(() => realpathSync(partitionPaths(binding).directory)).toThrow();
  // K2.01: An invalid value is refused before directory preparation.
  await expect(commitSnapshot(binding, {
    decode(value: unknown) {
      if (typeof value !== "string") throw new Error("invalid value");
      return value;
    },
    encode(value: string) { return value; },
  }, 0, undefined as unknown as string, deadline)).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(() => realpathSync(partitionPaths(binding).directory)).toThrow();
});

it("snapshot_prepublication_io_fault_matrix", async () => {
  const { binding, paths } = await fixture();
  await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  const before = readFileSync(paths.state);
  const beforeInode = lstatSync(paths.state).ino;

  let writes = 0;
  const short = await commitSnapshot(binding, codec, 1, { text: "short writes complete" }, performance.now() + 5_000, {
    async write(handle, bytes, offset) {
      writes++;
      return handle.write(bytes, offset, Math.min(5, bytes.length - offset), offset);
    },
  });
  // K2.07: A short write must complete every byte before a written receipt.
  expect(short).toMatchObject({ status: "written", generation: 2 });
  expect(writes).toBeGreaterThan(1);
  expect(readFileSync(paths.state).length).toBeGreaterThan(5);
  expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: "short writes complete" });

  const stable = readFileSync(paths.state);
  const stableInode = lstatSync(paths.state).ino;
  const ioError = () => Object.assign(new Error("injected I/O"), { code: "EIO" });
  for (const seam of [
    { async write() { return { bytesWritten: 0 }; } },
    { async write(handle: Parameters<NonNullable<import("../src/private-store/snapshot.js").SnapshotSeam["write"]>>[0], bytes: Buffer,
      offset: number) { if (offset) throw ioError(); return handle.write(bytes, offset, 5, offset); } },
    { async sync() { throw ioError(); } },
    { async close() { throw ioError(); } },
  ]) {
    // K2.07: A pre-rename I/O failure preserves canonical bytes and inode and removes only its owned temp.
    await expect(commitSnapshot(binding, codec, 2, { text: "refused" }, performance.now() + 5_000, seam))
      .rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: true, warnings: [] });
    expect(readFileSync(paths.state).equals(stable)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(stableInode);
    expect(readdirSync(paths.directory)).toEqual(["state.json"]);
  }

  const uuid = "12345678-1234-4123-8123-123456789abc";
  const collision = join(paths.directory, `.state-${uuid}.tmp`);
  let collisionInode = 0;
  // K2.07: EEXIST cannot authorize unlink of a colliding sentinel.
  await expect(commitSnapshot(binding, codec, 2, { text: "collision" }, performance.now() + 5_000, {
    uuid() {
      writeFileSync(collision, "sentinel", { mode: 0o600 });
      collisionInode = lstatSync(collision).ino;
      return uuid;
    },
  })).rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: true, warnings: [] });
  expect(collisionInode).toBeGreaterThan(0);
  expect(readFileSync(collision, "utf8")).toBe("sentinel");
  expect(lstatSync(collision).ino).toBe(collisionInode);
  expect(readFileSync(paths.state).equals(stable)).toBe(true);
  expect(lstatSync(paths.state).ino).toBe(stableInode);
  expect(await recoverSnapshot(binding, codec, performance.now() + 5_000)).toMatchObject({ discardedTemps: 1 });

  const absent = await fixture();
  await expect(commitSnapshot(absent.binding, codec, 0, { text: "zero" }, performance.now() + 5_000,
    { async write() { return { bytesWritten: 0 }; } })).rejects.toMatchObject({ code: "IO_UNAVAILABLE" });
  // K2.07: Initial-install refusal preserves genuine absence and leaves no temp or lock.
  expect(readdirSync(absent.paths.directory)).toEqual([]);
  expect(existsSync(absent.paths.state)).toBe(false);
  expect(before.length).toBeGreaterThan(0);
  expect(beforeInode).toBeGreaterThan(0);

  const stream = await fixture();
  let interruptedWrite = false;
  expect(await commitSnapshot(stream.binding, codec, 0, { text: "complete" }, performance.now() + 5_000, {
    async write(handle, bytes, offset) {
      if (!interruptedWrite) { interruptedWrite = true; throw Object.assign(new Error("interrupted"), { code: "EINTR" }); }
      return handle.write(bytes, offset, bytes.length - offset, offset);
    },
  })).toMatchObject({ status: "written", generation: 1 });
  // K2.07: Seam-injected EINTR retries without publishing a partial write.
  expect(interruptedWrite).toBe(true);
  expect(JSON.parse(readFileSync(stream.paths.state, "utf8")).payload).toEqual({ text: "complete" });
  let readCount = 0;
  const whole = await readSnapshot(stream.binding, codec, performance.now() + 5_000, (value) => value, {
    async read(handle, buffer) {
      readCount++;
      if (readCount === 1) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      return handle.read(buffer, 0, Math.min(buffer.length, 5), null);
    },
  });
  // K2.07: Short reads and EINTR still consume the complete canonical file before decoding.
  expect(readCount).toBeGreaterThan(2);
  expect(whole.status).toBe("read");
  if (whole.status !== "read") throw new Error("missing stream result");
  expect(JSON.parse(whole.output.toString())).toEqual({ text: "complete" });
  const streamBytes = readFileSync(stream.paths.state);
  let firstRead = true;
  await expect(readSnapshot(stream.binding, codec, performance.now() + 5_000, (value) => value, {
    async read(handle, buffer) {
      if (firstRead) {
        firstRead = false;
        return handle.read(buffer, 0, 5, null);
      }
      throw Object.assign(new Error("mid-read"), { code: "EIO" });
    },
  })).rejects.toMatchObject({ code: "IO_UNAVAILABLE" });
  // K2.07: A valid prefix followed by a read failure never yields content or changes state.
  expect(readFileSync(stream.paths.state).equals(streamBytes)).toBe(true);
}, 15_000);

it("snapshot_process_crash_and_recovery_matrix", async () => {
  for (const phase of ["lock", "temp-open", "partial-temp", "temp-flushed", "before-rename", "after-rename", "folder-flushed"]) {
    const { workspace, binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    const prior = readFileSync(paths.state);
    const child = spawn(process.execPath,
      [new URL("./fixtures/private-store/snapshot/crash.mjs", import.meta.url).pathname, workspace, phase, "1"],
      { stdio: ["ignore", "pipe", "pipe"] });
    const barrier = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`BARRIER:${phase}\n`)) resolve(output);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`child exited ${code} before ${phase}: ${output}`)));
    });
    // K2.08: Each real process reaches its named filesystem barrier before SIGKILL.
    expect(barrier).toContain(`BARRIER:${phase}`);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // K2.08: The interrupted owner's lock is never stolen by read or recovery.
    await expect(readSnapshot(binding, codec, performance.now() + 5_000)).rejects.toMatchObject({ code: "LOCK_HELD" });
    expect(existsSync(paths.lock)).toBe(true);
    rmdirSync(paths.lock);
    const installed = phase === "after-rename" || phase === "folder-flushed";
    const currentBytes = readFileSync(paths.state);
    if (installed) expect(JSON.parse(currentBytes.toString()).payload).toEqual({ text: `installed-${phase}` });
    else expect(currentBytes.equals(prior)).toBe(true);
    const temps = readdirSync(paths.directory).filter((name) => name.endsWith(".tmp"));
    if (temps.length) {
      // K2.08: A staged temp blocks read until explicit recovery; recovery never promotes it.
      await expect(readSnapshot(binding, codec, performance.now() + 5_000)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    }
    expect(await recoverSnapshot(binding, codec, performance.now() + 5_000))
      .toMatchObject({ status: "recovered", generation: installed ? 2 : 1, discardedTemps: temps.length });
    expect(readdirSync(paths.directory)).toEqual(["state.json"]);
    expect(readFileSync(paths.state).equals(currentBytes)).toBe(true);
  }
}, 30_000);

it("snapshot_postrename_faults_report_written", async () => {
  const ioError = () => Object.assign(new Error("injected I/O"), { code: "EIO" });
  for (const faults of ["directory", "inventory", "release", "all"]) {
    const { binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    let listings = 0;
    const operation = commitSnapshot(binding, codec, 1, { text: faults }, performance.now() + 5_000, {
      async sync(handle) {
        if ((await handle.stat()).isDirectory() && (faults === "directory" || faults === "all")) throw ioError();
        await handle.sync();
      },
      async opendir(path) {
        listings++;
        if (listings === 2 && (faults === "inventory" || faults === "all")) throw ioError();
        return opendir(path);
      },
      async rmdir(path) {
        if (faults === "release" || faults === "all") throw ioError();
        return rmdirSync(path);
      },
    });
    await expect(operation).resolves.toMatchObject({ status: "written", generation: 2 });
    const receipt = await operation;
    const directoryFault = faults === "directory" || faults === "all";
    const inventoryFault = faults === "inventory" || faults === "all";
    const releaseFault = faults === "release" || faults === "all";
    // K2.09: Faults after rename preserve a written receipt with ordered, combined warnings.
    expect(receipt).toEqual({ status: "written", generation: 2,
      durability: directoryFault ? "unverified" : "synced", inventoryVerified: !inventoryFault,
      lockReleased: !releaseFault, warnings: [
        ...(directoryFault ? ["DIRECTORY_NOT_FLUSHED"] : []),
        ...(inventoryFault ? ["INVENTORY_UNVERIFIED"] : []),
        ...(releaseFault ? ["LOCK_LEFT"] : []),
      ] });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: faults });
    if (releaseFault) rmdirSync(paths.lock);
    // K2.09: The old generation is stale even when acknowledgement includes warnings.
    await expect(commitSnapshot(binding, codec, 1, { text: "stale" }, performance.now() + 5_000))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).generation).toBe(2);
  }
  const { binding, paths } = await fixture();
  const canary = join(paths.lock, "canary");
  const receipt = await commitSnapshot(binding, codec, 0, { text: "installed" }, performance.now() + 5_000, {
    async rename(source, target) {
      await rename(source, target);
      writeFileSync(canary, "outside entry");
    },
  });
  // K2.09: Inventory is unverified when this holder's lock is not empty after installation.
  expect(receipt).toEqual({ status: "written", generation: 1, durability: "synced",
    inventoryVerified: false, lockReleased: false, warnings: ["INVENTORY_UNVERIFIED", "LOCK_LEFT"] });
  expect(JSON.parse(readFileSync(paths.state, "utf8")).generation).toBe(1);
  rmSync(canary);
  rmdirSync(paths.lock);
});

it("snapshot_deadline_fences_late_continuations", async () => {
  const definite = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EXDEV", "EINVAL", "EISDIR", "ENOTEMPTY", "EBUSY", "EROFS"];
  const fault = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
  for (const code of definite) {
    const { binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    const before = readFileSync(paths.state);
    const inode = lstatSync(paths.state).ino;
    const entries = readdirSync(paths.directory);
    // K2.10: Every definite in-budget mismatch refuses and cleans only this operation's staging objects.
    await expect(commitSnapshot(binding, codec, 1, { text: code }, performance.now() + 5_000,
      { async rename() { throw fault(code); } }))
      .rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: true, warnings: [] });
    expect(readFileSync(paths.state).equals(before)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(inode);
    expect(readdirSync(paths.directory)).toEqual(entries);
  }

  const matched = await fixture();
  await commitSnapshot(matched.binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  const positive = await commitSnapshot(matched.binding, codec, 1, { text: "installed" }, performance.now() + 5_000, {
    async rename(source, target) { await rename(source, target); throw fault("ENOENT"); },
  });
  // K2.10: A matching inode witnesses installation even when rename reports an error.
  expect(positive).toMatchObject({ status: "written", generation: 2 });
  expect(JSON.parse(readFileSync(matched.paths.state, "utf8")).payload).toEqual({ text: "installed" });

  const initial = await fixture();
  const unknown = await commitSnapshot(initial.binding, codec, 0, { text: "new" }, performance.now() + 5_000,
    { async rename() { throw fault("ENOENT"); } });
  // K2.10: Missing initial target supplies no inode witness, so the outcome stays uncertain.
  expect(unknown).toEqual({ status: "uncertain", code: "WRITE_OUTCOME_UNKNOWN", lockReleased: false, warnings: ["LOCK_LEFT"] });
  expect(existsSync(initial.paths.state)).toBe(false);
  expect(readdirSync(initial.paths.directory).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  rmdirSync(initial.paths.lock);
  expect(await recoverSnapshot(initial.binding, codec, performance.now() + 5_000))
    .toMatchObject({ status: "recovered", generation: 0, discardedTemps: 1 });

  for (const installs of [false, true]) {
    const { binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    const before = readFileSync(paths.state);
    const trace: string[] = [];
    let renameReturned = false;
    const operation = commitSnapshot(binding, codec, 1, { text: "late" }, performance.now() + 25, {
      async rename(source, target) {
        if (installs) await rename(source, target);
        await new Promise((resolve) => setTimeout(resolve, 60));
        renameReturned = true;
        throw fault("ENOENT");
      },
      async lstat(path) { if (renameReturned) trace.push(`lstat:${path}`); return lstat(path); },
      async unlink(path) { if (renameReturned) trace.push(`unlink:${path}`); throw Error("late unlink"); },
      async rmdir(path) { if (renameReturned) trace.push(`rmdir:${path}`); throw Error("late rmdir"); },
      async opendir(path) { if (renameReturned) trace.push(`opendir:${path}`); return opendir(path); },
      async sync(handle) { if (renameReturned) trace.push("sync"); await handle.sync(); },
    });
    // K2.10: A late rejected rename has no post-expiry witness and retains lock and temp evidence.
    await expect(operation).resolves.toMatchObject({ status: "uncertain", code: "WRITE_OUTCOME_UNKNOWN" });
    const late = await operation;
    expect(late).toEqual({ status: "uncertain", code: "WRITE_OUTCOME_UNKNOWN", lockReleased: false, warnings: ["LOCK_LEFT"] });
    expect(trace).toEqual([]);
    expect(existsSync(paths.lock)).toBe(true);
    if (installs) expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: "late" });
    else expect(readFileSync(paths.state).equals(before)).toBe(true);
    rmdirSync(paths.lock);
    expect(await recoverSnapshot(binding, codec, performance.now() + 5_000))
      .toMatchObject({ status: "recovered", generation: installs ? 2 : 1, discardedTemps: installs ? 0 : 1 });
  }

  const lateSuccess = await fixture();
  await commitSnapshot(lateSuccess.binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  const completed = await commitSnapshot(lateSuccess.binding, codec, 1, { text: "installed" }, performance.now() + 25, {
    async rename(source, target) {
      await rename(source, target);
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
  });
  // K2.10: Awaited late success is written, while later flush, inventory and release remain skipped.
  expect(completed).toEqual({ status: "written", generation: 2, durability: "unverified", inventoryVerified: false,
    lockReleased: false, warnings: ["DIRECTORY_NOT_FLUSHED", "INVENTORY_UNVERIFIED", "LOCK_LEFT"] });
  expect(existsSync(lateSuccess.paths.lock)).toBe(true);
  expect(JSON.parse(readFileSync(lateSuccess.paths.state, "utf8")).generation).toBe(2);
  rmdirSync(lateSuccess.paths.lock);

  for (const installs of [false, true]) {
    const { binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    const before = readFileSync(paths.state);
    let renameRejected = false;
    const trace: string[] = [];
    const operation = commitSnapshot(binding, codec, 1, { text: "delayed witness" }, performance.now() + 25, {
      async rename(source, target) {
        if (installs) await rename(source, target);
        renameRejected = true;
        throw fault("ENOENT");
      },
      async lstat(path) {
        if (renameRejected && path === paths.state) {
          trace.push("witness submitted");
          const info = await lstat(path);
          await new Promise((resolve) => setTimeout(resolve, 60));
          trace.push("witness completed");
          return info;
        }
        return lstat(path);
      },
      async unlink(path) { trace.push(`unlink:${path}`); throw Error("late unlink"); },
      async rmdir(path) { trace.push(`rmdir:${path}`); throw Error("late rmdir"); },
    });
    if (installs) {
      // K2.10: An already-submitted inode witness may confirm a written generation after expiry.
      expect(await operation).toMatchObject({ status: "written", generation: 2, durability: "unverified", lockReleased: false });
      expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: "delayed witness" });
    } else {
      // K2.10: A late definite mismatch is IO_UNAVAILABLE with staging objects retained.
      await expect(operation).rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: false, warnings: ["LOCK_LEFT"] });
      expect(readFileSync(paths.state).equals(before)).toBe(true);
      expect(readdirSync(paths.directory).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    }
    expect(trace).toEqual(["witness submitted", "witness completed"]);
    expect(existsSync(paths.lock)).toBe(true);
    rmdirSync(paths.lock);
    await recoverSnapshot(binding, codec, performance.now() + 5_000);
  }

  const lateRead = await fixture();
  await commitSnapshot(lateRead.binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  const readTrace: string[] = [];
  await expect(readSnapshot(lateRead.binding, codec, performance.now() + 25, (value) => value, {
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      if (path === lateRead.paths.state) {
        readTrace.push("state open submitted");
        await new Promise((resolve) => setTimeout(resolve, 60));
        readTrace.push("state open completed");
      }
      return handle;
    },
    async rmdir(path) { readTrace.push(`rmdir:${path}`); return rmdirSync(path); },
  })).rejects.toMatchObject({ code: "DEADLINE", lockReleased: false, warnings: ["LOCK_LEFT"] });
  // K2.10: A late opened read handle closes without post-expiry lock removal or content delivery.
  expect(readTrace).toEqual(["state open submitted", "state open completed"]);
  expect(existsSync(lateRead.paths.lock)).toBe(true);
  rmdirSync(lateRead.paths.lock);

  const lateRelease = await fixture();
  await commitSnapshot(lateRelease.binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  const releaseTrace: string[] = [];
  const lateReadRelease = readSnapshot(lateRelease.binding, codec, performance.now() + 25, (value) => value, {
    async rmdir(path) {
      releaseTrace.push(`rmdir:${path}`);
      rmdirSync(path);
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
  });
  // K2.10: A late completed lock removal refuses content and reports the observed released lock.
  await expect(lateReadRelease).rejects.toMatchObject({ code: "DEADLINE", lockReleased: true, warnings: [] });
  expect(releaseTrace).toEqual([`rmdir:${lateRelease.paths.lock}`]);
  expect(existsSync(lateRelease.paths.lock)).toBe(false);

  const swap = await fixture();
  await commitSnapshot(swap.binding, codec, 0, { text: "original" }, performance.now() + 5_000);
  const outside = join(swap.workspace, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const alternate = JSON.parse(readFileSync(swap.paths.state, "utf8"));
  alternate.payload.text = "outside";
  writeFileSync(join(outside, "state.json"), JSON.stringify(alternate) + "\n", { mode: 0o600 });
  const moved = `${swap.paths.directory}.moved`;
  let observed = "";
  let redirected = "";
  try {
    await expect(readSnapshot(swap.binding, codec, performance.now() + 5_000,
      (value) => { observed = value.text; return value; }, {
        async open(path, flags, mode) {
          if (path === swap.paths.state) {
            renameSync(swap.paths.directory, moved);
            symlinkSync(outside, swap.paths.directory);
            redirected = realpathSync(path);
          }
          return open(path, flags, mode);
        },
      })).rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: false, warnings: ["LOCK_LEFT"] });
    // K2.10: An ancestor swap can redirect an in-flight read outside the managed folder.
    expect(redirected).toBe(join(outside, "state.json"));
    expect(observed).toBe("outside");
  } finally {
    if (existsSync(moved)) {
      if (lstatSync(swap.paths.directory).isSymbolicLink()) rmSync(swap.paths.directory);
      renameSync(moved, swap.paths.directory);
      rmdirSync(swap.paths.lock);
    }
  }
}, 30_000);

it("snapshot_public_text_and_retry_matrix", async () => {
  const documentation = readFileSync(new URL("../docs/private-store.md", import.meta.url), "utf8");
  const required = [
    "A missing snapshot has generation zero; a committed change installs one complete bounded snapshot with the next generation.",
    "Corrupt committed state is refused rather than replaced with empty state or an old temporary snapshot.",
    "Snapshot reads and writes cooperate through one partition lock; a held lock is reported without automatic takeover.",
    "A snapshot is limited to 16 MiB, and managed state plus temporary files to 32 MiB.",
    "An interrupted process can leave a lock or temporary file that blocks access until explicit recovery.",
    "Before manually removing an interrupted lock, establish that no cooperating operation is active; recovery does not establish that from its age or PID.",
    "After a successful rename, a directory-flush or lock-cleanup failure is reported as a written change with warnings.",
    "durability:\"synced\" means fsync calls on the file and its folder returned without error.",
    "The library checks that the private folders and state file are owned by the current user with owner-only permission bits; "
      + "it does not read access-control lists, so an entry granting another user access is not detected.",
    "An uncertain rename outcome needs inspection before retry; it is not a request to repeat the mutation.",
    "The operation budget stops the next I/O step after expiry, but an OS operation already submitted may complete later, "
      + "and the call returns only after it has.",
    "If a caller's output pipe fails, already delivered bytes may remain with the reader and an installed snapshot may already have changed.",
    "The macOS snapshot tests cover process interruption on the tested local filesystem; power-loss survival has not been established.",
    "The Linux snapshot tests cover the tested local filesystem; behaviour on unidentified remote or cloud-synced homes "
      + "and power-loss survival has not been established.",
    "Windows snapshot storage is unavailable pending a verified native privacy adapter; its rename, locking and crash "
      + "behaviour has not been verified by this card.",
    "A program that can replace a private-store folder between the last safety check and a filesystem operation is not defended against.",
    "Such a replacement can redirect that operation outside the private-store folder.",
    "This local store does not defend against a program running under the user's account or as an administrator.",
  ];
  // K2.12: The exact bounded public statements and limits appear in the library documentation.
  for (const sentence of required) expect(documentation).toContain(sentence);

  const { workspace, binding, paths } = await fixture();
  const child = spawn(process.execPath,
    [new URL("./fixtures/private-store/snapshot/report.mjs", import.meta.url).pathname, workspace],
    { stdio: ["pipe", "pipe", "pipe"] });
  let prefix = Buffer.alloc(0);
  let errorText = "";
  child.stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length >= 100) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited ${code} before prefix`)));
  });
  // K2.12: The reader retains the first 100 accepted bytes before closing its pipe.
  expect(prefix.length).toBe(100);
  child.stdout.destroy();
  child.stdin.write("resume\n");
  child.stdin.end();
  const exit = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const receipt = JSON.parse(errorText.trim().split("\n").at(-1)!);
  // K2.12: A real output failure gives a nonzero fixture exit while the installed generation remains two-way inspectable.
  expect(exit).toBe(1);
  expect(receipt).toEqual({ outputFailure: true, savedGeneration: 1, warnings: [] });
  expect(JSON.parse(readFileSync(paths.state, "utf8")).generation).toBe(1);
  expect(await readSnapshot(binding, codec, performance.now() + 5_000)).toMatchObject({ status: "read", generation: 1 });
}, 15_000);
