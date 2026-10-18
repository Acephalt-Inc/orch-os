import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindWorkspace, partitionPaths } from "../src/private-store/binding.js";
import { preparePartition } from "../src/private-store/privacy.js";
import { commitSnapshot, mutateSnapshot, readSnapshot, recoverSnapshot, type SnapshotCodec, type SnapshotSeam } from "../src/private-store/snapshot.js";

describe.skipIf(process.platform === "win32")("POSIX private-store snapshots", () => {

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

it.each(["post_mkdir_lstat", "pre_mkdir"] as const)("snapshot_lock_acquisition_%s", async (acquisitionCase) => {
  for (const kind of ["read", "commit", "mutate", "recover"] as const) {
    const { binding, paths } = await fixture();
    await preparePartition(binding, performance.now() + 5_000);
    const trace: string[] = [];
    const fault = Object.assign(new Error(`injected ${acquisitionCase}`), { code: "EIO" });
    const seam = {
      async mkdir(path: string, options: { mode: number }) {
        trace.push(`mkdir:${path}`);
        if (path === paths.lock && acquisitionCase === "pre_mkdir") throw fault;
        return mkdir(path, options);
      },
      async lstat(path: string) {
        trace.push(`lstat:${path}`);
        if (path === paths.lock && acquisitionCase === "post_mkdir_lstat") throw fault;
        return lstat(path);
      },
    };
    const operation = kind === "read"
      ? readSnapshot(binding, codec, performance.now() + 5_000, undefined, seam)
      : kind === "commit"
        ? commitSnapshot(binding, codec, 0, { text: "fault" }, performance.now() + 5_000, seam)
        : kind === "mutate"
          ? mutateSnapshot(binding, codec, 0, performance.now() + 5_000, () => ({ text: "fault" }), seam)
          : recoverSnapshot(binding, codec, performance.now() + 5_000, seam);
    const error = await operation.then(() => undefined, (reason: unknown) => reason);
    const lockExists = existsSync(paths.lock);
    const lockInode = lockExists ? lstatSync(paths.lock).ino : null;
    console.log(JSON.stringify({ acquisitionCase, kind, trace, code: (error as { code?: string })?.code,
      lockReleased: (error as { lockReleased?: boolean })?.lockReleased,
      warnings: (error as { warnings?: string[] })?.warnings, lockExists, lockInode,
      entries: readdirSync(paths.directory) }));
    if (acquisitionCase === "post_mkdir_lstat") {
      expect(error).toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: false, warnings: ["LOCK_LEFT"] });
      expect(lockExists).toBe(true);
      expect(lstatSync(paths.lock).ino).toBe(lockInode);
    } else {
      expect(error).toMatchObject({ code: "IO_UNAVAILABLE" });
      expect(lockExists).toBe(false);
      expect((error as { warnings?: string[] }).warnings ?? []).not.toContain("LOCK_LEFT");
      if ((error as { lockReleased?: boolean }).lockReleased !== undefined) {
        expect((error as { lockReleased?: boolean }).lockReleased).toBe(true);
      }
    }
    expect(existsSync(paths.state)).toBe(false);
  }
});

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

it("snapshot_directory_iteration_faults", async () => {
  const { binding, paths } = await fixture();
  const initial = await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  expect(initial.status).toBe("written");
  const before = readdirSync(paths.directory);
  const beforeState = lstatSync(paths.state);
  const trace: Array<Record<string, unknown>> = [];
  let partitionListings = 0;
  const receipt = await commitSnapshot(binding, codec, 1, { text: "installed" }, performance.now() + 5_000, {
    async opendir(path) {
      const submitted = performance.now();
      const directory = await opendir(path);
      if (path === paths.directory && ++partitionListings === 2) {
        const close = directory.close.bind(directory);
        directory.close = async () => {
          await close();
          trace.push({ site: "directory-handle.close", path, submitted, completed: performance.now(),
            errno: "EIO", dev: beforeState.dev, ino: beforeState.ino });
          throw Object.assign(new Error("injected directory close"), { code: "EIO" });
        };
      }
      return directory;
    },
  });
  const after = readdirSync(paths.directory);
  console.log(JSON.stringify({ row: 5, trace, before, after, receipt,
    state: { dev: lstatSync(paths.state).dev, ino: lstatSync(paths.state).ino },
    lockExists: existsSync(paths.lock) }));
  expect(trace).toHaveLength(1);
  expect(receipt).toMatchObject({ status: "written", generation: 2, inventoryVerified: false,
    warnings: ["INVENTORY_UNVERIFIED"] });
  expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: "installed" });
});

it("snapshot_deadline_fences_late_continuations", async () => {
  const definite = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EXDEV", "EINVAL", "EISDIR", "ENOTEMPTY", "EBUSY", "EROFS"];
  const fault = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
  // Keep setup in budget; expire only when the targeted continuation settles.
  const deadlineClock = () => {
    const deadline = 25;
    let now = 0;
    return { deadline, clock: () => now, expire: () => { now = deadline; } };
  };
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
    const budget = deadlineClock();
    const operation = commitSnapshot(binding, codec, 1, { text: "late" }, budget.deadline, {
      clock: budget.clock,
      async rename(source, target) {
        if (installs) await rename(source, target);
        budget.expire();
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
  const successBudget = deadlineClock();
  const completed = await commitSnapshot(lateSuccess.binding, codec, 1, { text: "installed" }, successBudget.deadline, {
    clock: successBudget.clock,
    async rename(source, target) {
      await rename(source, target);
      successBudget.expire();
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
    const budget = deadlineClock();
    const operation = commitSnapshot(binding, codec, 1, { text: "delayed witness" }, budget.deadline, {
      clock: budget.clock,
      async rename(source, target) {
        if (installs) await rename(source, target);
        renameRejected = true;
        throw fault("ENOENT");
      },
      async lstat(path) {
        if (renameRejected && path === paths.state) {
          trace.push("witness submitted");
          const info = await lstat(path);
          budget.expire();
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
  const readBudget = deadlineClock();
  await expect(readSnapshot(lateRead.binding, codec, readBudget.deadline, (value) => value, {
    clock: readBudget.clock,
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      if (path === lateRead.paths.state) {
        readTrace.push("state open submitted");
        readBudget.expire();
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
  const releaseBudget = deadlineClock();
  const lateReadRelease = readSnapshot(lateRelease.binding, codec, releaseBudget.deadline, (value) => value, {
    clock: releaseBudget.clock,
    async rmdir(path) {
      releaseTrace.push(`rmdir:${path}`);
      rmdirSync(path);
      releaseBudget.expire();
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

// Direct-site audit. Each case uses a real private fixture and faults one lexical call.
const auditSites = [
  [1, "snapshot_directory_handle_faults"], [2, "snapshot_directory_handle_faults"],
  [3, "snapshot_postrename_faults_report_written"], [4, "snapshot_directory_iteration_faults"],
  [6, "snapshot_inventory_lstat_faults"], [9, "snapshot_cleanup_identity_faults"],
  [10, "snapshot_postrename_faults_report_written"], [11, "snapshot_recovery_temp_unlink_faults"],
  [12, "snapshot_prepublication_io_fault_matrix"], [13, "snapshot_temp_identity_and_close_faults"],
  [14, "snapshot_prepublication_io_fault_matrix"], [15, "snapshot_prepublication_io_fault_matrix"],
  [16, "snapshot_prepublication_io_fault_matrix"], [17, "snapshot_temp_identity_and_close_faults"],
  [18, "snapshot_deadline_fences_late_continuations"], [19, "snapshot_rename_witness_faults"],
  [20, "snapshot_postrename_faults_report_written"], [21, "snapshot_directory_handle_faults"],
  [22, "snapshot_directory_handle_faults"],
] as const;

it.each(auditSites)("%s %s direct_site_probe", async (row, name) => {
  void name;
  const { binding, paths } = await fixture();
  const prior = await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
  expect(prior.status).toBe("written");
  const oldBytes = readFileSync(paths.state);
  const oldInode = lstatSync(paths.state).ino;
  const before = readdirSync(paths.directory);
  const trace: Array<{ site: string; path: string; submitted: number; completed: number; errno: string }> = [];
  const fault = () => Object.assign(new Error(`audit row ${row} EIO`), { code: "EIO" });
  const hit = (site: string, path: string) => {
    const submitted = performance.now();
    trace.push({ site, path, submitted, completed: performance.now(), errno: "EIO" });
    throw fault();
  };
  const seam: import("../src/private-store/snapshot.js").SnapshotSeam = {};
  let listed = 0;
  let installed = false;
  let targetCount = 0;
  let tempPath = "";
  let clockShift = 0;
  const deadline = performance.now() + 5_000;
  const tempName = ".state-12345678-1234-4123-8123-123456789abc.tmp";
  if (row === 2) seam.clock = () => performance.now() + clockShift;
  if ([1, 2, 12, 13, 16, 17, 21, 22].includes(row)) {
    seam.open = async (path, flags, mode) => {
      if (row === 1 && installed && path === paths.directory) hit("open-folder", path);
      if (row === 12 && path.endsWith(".tmp")) hit("open-temp", path);
      const handle = await open(path, flags, mode);
      if (row === 2 && installed && path === paths.directory) {
        const close = handle.close.bind(handle);
        handle.close = async () => { const submitted = performance.now(); await close();
          trace.push({ site: "late-folder-close", path, submitted, completed: performance.now(), errno: "EIO" });
          throw fault(); };
        clockShift = 6_000;
      }
      if (row === 13 && path.endsWith(".tmp")) {
        handle.stat = async () => hit("temp-stat", path);
      }
      if (row === 17 && path.endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        handle.close = async () => { const submitted = performance.now(); await close();
          trace.push({ site: "fallback-temp-close", path, submitted, completed: performance.now(), errno: "EIO" });
          throw fault(); };
      }
      if (row === 22 && installed && path === paths.directory) {
        const close = handle.close.bind(handle);
        handle.close = async () => { const submitted = performance.now(); await close();
          trace.push({ site: "fallback-folder-close", path, submitted, completed: performance.now(), errno: "EIO" });
          throw fault(); };
      }
      return handle;
    };
  }
  if ([3, 4].includes(row)) {
    seam.opendir = async (path) => {
      if (path === paths.directory) listed++;
      if (row === 3 && path === paths.directory && listed === 2) hit("opendir", path);
      const handle = await opendir(path);
      if (row === 4 && path === paths.directory && listed === 2) {
        handle.read = async () => hit("directory-read", path);
      }
      return handle;
    };
  }
  if ([6, 9, 19].includes(row)) {
    seam.lstat = async (path) => {
      if (row === 6 && installed && path === paths.state) hit("inventory-lstat", path);
      if (row === 9 && installed && path === paths.lock && ++targetCount === 2) hit("removal-lstat", path);
      if (row === 19 && installed && path === paths.state) hit("rename-witness-lstat", path);
      return lstat(path);
    };
  }
  if (row === 10) seam.rmdir = async (path) => hit("lock-rmdir", path);
  if (row === 2) {
    seam.opendir = async (path) => { if (clockShift) hit("late-opendir", path); return opendir(path); };
    seam.lstat = async (path) => { if (clockShift) hit("late-lstat", path); return lstat(path); };
    seam.rmdir = async (path) => { if (clockShift) hit("late-rmdir", path); return rmdirSync(path); };
    seam.sync = async (handle) => { if (clockShift) hit("late-sync", paths.directory); await handle.sync(); };
  }
  if (row === 11) {
    tempPath = join(paths.directory, tempName);
    writeFileSync(tempPath, "orphan", { mode: 0o600 });
    seam.unlink = async (path) => hit("temp-unlink", path);
  }
  if (row === 14 || row === 17) seam.write = async (_handle, _bytes, _offset) => hit("temp-write", tempPath);
  if ([15, 20, 22].includes(row)) seam.sync = async (handle) => {
    if ((await handle.stat()).isDirectory() === (row !== 15)) hit(row === 15 ? "temp-sync" : "folder-sync", row === 15 ? tempPath : paths.directory);
    await handle.sync();
  };
  if (row === 16 || row === 21) seam.close = async (handle) => {
    const info = await handle.stat();
    const isTarget = info.isDirectory() === (row === 21);
    await handle.close();
    if (isTarget) hit(row === 21 ? "folder-close" : "temp-close", row === 21 ? paths.directory : tempPath);
  };
  if ([1, 2, 6, 9, 18, 19, 21, 22].includes(row)) seam.rename = async (source, target) => {
    if (row === 18) hit("rename", source);
    if (row === 19) { installed = true; hit("rename", source); }
    await rename(source, target);
    installed = true;
  };
  if ([13, 14, 15, 16, 17].includes(row)) seam.open = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (path.endsWith(".tmp")) {
      tempPath = path;
      if (row === 13) handle.stat = async () => hit("temp-stat", path);
      if (row === 17) {
        const close = handle.close.bind(handle);
        handle.close = async () => { const submitted = performance.now(); await close();
          trace.push({ site: "fallback-temp-close", path, submitted, completed: performance.now(), errno: "EIO" });
          throw fault(); };
      }
    }
    return handle;
  };
  const operation = row === 11
    ? recoverSnapshot(binding, codec, deadline, seam)
    : commitSnapshot(binding, codec, 1, { text: `row-${row}` }, deadline, seam);
  const actual = await operation.then((value) => value, (error: unknown) => error);
  const after = readdirSync(paths.directory);
  const state = lstatSync(paths.state);
  const summary = actual instanceof Error
    ? { code: (actual as Error & { code?: string }).code,
      lockReleased: (actual as Error & { lockReleased?: boolean }).lockReleased,
      warnings: (actual as Error & { warnings?: string[] }).warnings }
    : actual;
  console.log(JSON.stringify({ auditRow: row, trace, before, after, oldInode, state: { dev: state.dev, ino: state.ino },
    result: summary, lockExists: existsSync(paths.lock), tempExists: tempPath ? existsSync(tempPath) : undefined }));
  expect(trace.some((event) => event.site !== "rename" || row === 18)).toBe(true);
  if (row === 2) expect(trace.map((event) => event.site)).toEqual(["late-folder-close"]);
  if ([1, 2, 20, 21, 22].includes(row)) {
    expect(actual).toMatchObject({ status: "written", generation: 2, durability: "unverified",
      warnings: expect.arrayContaining(["DIRECTORY_NOT_FLUSHED"]) });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: `row-${row}` });
  } else if ([3, 4, 6].includes(row)) {
    expect(actual).toMatchObject({ status: "written", generation: 2, inventoryVerified: false,
      warnings: expect.arrayContaining(["INVENTORY_UNVERIFIED"]) });
  } else if ([9, 10].includes(row)) {
    expect(actual).toMatchObject({ status: "written", generation: 2, lockReleased: false,
      warnings: expect.arrayContaining(["LOCK_LEFT"]) });
    expect(existsSync(paths.lock)).toBe(true);
  } else if (row === 18 || row === 19) {
    expect(actual).toEqual({ status: "uncertain", code: "WRITE_OUTCOME_UNKNOWN", lockReleased: false,
      warnings: ["LOCK_LEFT"] });
  } else {
    expect(actual).toMatchObject({ code: "IO_UNAVAILABLE" });
    expect(readFileSync(paths.state).equals(oldBytes)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(oldInode);
    if (row === 11 || row === 13) expect(existsSync(tempPath)).toBe(true);
  }
}, 15_000);

// Shared direct sites must also refuse reads and recovery without publishing content.
const sharedAuditSites = [3, 4, 6, 9, 10] as const;
it.each(sharedAuditSites)("shared_site_probe row %s", async (row) => {
  for (const kind of row <= 6 ? ["read", "mutate", "recover"] as const : ["read", "recover"] as const) {
    const { binding, paths } = await fixture();
    await commitSnapshot(binding, codec, 0, { text: "prior" }, performance.now() + 5_000);
    const bytes = readFileSync(paths.state);
    const inode = lstatSync(paths.state).ino;
    const entries = readdirSync(paths.directory);
    const fault = () => Object.assign(new Error(`shared audit ${row} EIO`), { code: "EIO" });
    const trace: Array<{ site: string; path: string; submitted: number; completed: number; errno: string }> = [];
    const hit = (site: string, path: string) => {
      const submitted = performance.now();
      trace.push({ site, path, submitted, completed: performance.now(), errno: "EIO" });
      throw fault();
    };
    let lockStats = 0;
    const seam: import("../src/private-store/snapshot.js").SnapshotSeam = {};
    if (row === 3 || row === 4) seam.opendir = async (path) => {
      if (row === 3 && path === paths.directory) hit("opendir", path);
      const handle = await opendir(path);
      if (row === 4 && path === paths.directory) handle.read = async () => hit("directory-read", path);
      return handle;
    };
    if (row === 6 || row === 9) seam.lstat = async (path) => {
      if (row === 6 && path === paths.state) hit("inventory-lstat", path);
      if (row === 9 && path === paths.lock && ++lockStats === 3) hit("removal-lstat", path);
      return lstat(path);
    };
    if (row === 10) seam.rmdir = async (path) => hit("lock-rmdir", path);
    const deadline = performance.now() + 5_000;
    const operation = kind === "read"
      ? readSnapshot(binding, codec, deadline, (value) => value, seam)
      : kind === "mutate"
        ? mutateSnapshot(binding, codec, 1, deadline, () => ({ text: "new" }), seam)
        : recoverSnapshot(binding, codec, deadline, seam);
    const actual = await operation.then(() => undefined, (error: unknown) => error);
    const summary = { code: (actual as { code?: string })?.code,
      lockReleased: (actual as { lockReleased?: boolean })?.lockReleased,
      warnings: (actual as { warnings?: string[] })?.warnings };
    console.log(JSON.stringify({ sharedAuditRow: row, kind, trace, before: entries, after: readdirSync(paths.directory),
      beforeInode: inode, afterInode: lstatSync(paths.state).ino, result: summary, lockExists: existsSync(paths.lock) }));
    expect(trace).toHaveLength(1);
    expect(actual).toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: row <= 6,
      warnings: row <= 6 ? [] : ["LOCK_LEFT"] });
    expect(existsSync(paths.lock)).toBe(row >= 9);
    expect(readFileSync(paths.state).equals(bytes)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(inode);
  }
}, 15_000);

// Reviewer public-API probes: four entry-limit pairs, four deadline pairs, four read-EIO controls, and eight acquisition controls.
for (const primary of ["TOO_LARGE", "EIO"] as const) {
  for (const api of ["read", "commit", "mutate", "recover"] as const) {
    it(`snapshot_names_primary_${primary}_close_EIO_api_${api}`, async () => {
      const workspace = mkdtempSync(join(tmpdir(), "review-k2-"));
      homes.push(workspace);
      const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
      const paths = partitionPaths(binding);
      await preparePartition(binding, performance.now() + 5_000);
      await commitSnapshot(binding, codec, 0, { text: "old" }, performance.now() + 5_000);
      const before = lstatSync(paths.state);
      if (primary === "TOO_LARGE") {
        for (let i = 0; i < 32; i++) {
          writeFileSync(join(paths.directory, `.state-${i.toString(16).padStart(8, "0")}-1234-4123-8123-123456789abc.tmp`), "x", { mode: 0o600 });
        }
      }
      let readFaults = 0;
      let closeFaults = 0;
      const seam: SnapshotSeam = {
        opendir: async (path) => {
          const dir = await opendir(path);
          if (path === paths.directory) {
            const close = dir.close.bind(dir);
            dir.close = async () => {
              await close();
              closeFaults++;
              throw Object.assign(new Error("injected close"), { code: "EIO" });
            };
            if (primary === "EIO") {
              const read = dir.read.bind(dir);
              dir.read = async () => {
                if (++readFaults === 1) {
                  throw Object.assign(new Error("injected read"), { code: "EIO" });
                }
                return read();
              };
            }
          }
          return dir;
        },
      };
      const deadline = performance.now() + 5_000;
      const action = api === "read" ? readSnapshot(binding, codec, deadline, (value) => value, seam)
        : api === "commit" ? commitSnapshot(binding, codec, 1, { text: "new" }, deadline, seam)
        : api === "mutate" ? mutateSnapshot(binding, codec, 1, deadline, () => ({ text: "new" }), seam)
        : recoverSnapshot(binding, codec, deadline, seam);
      const actual = await action.then((value) => value, (error: unknown) => error);
      const summary = actual instanceof Error
        ? { code: (actual as Error & { code?: string }).code, lockReleased: (actual as Error & { lockReleased?: boolean }).lockReleased,
          warnings: (actual as Error & { warnings?: string[] }).warnings }
        : actual;
      console.log(JSON.stringify({ primary, api, closeFaults, readFaults, result: summary,
        entries: readdirSync(paths.directory).length, canonicalSame: lstatSync(paths.state).ino === before.ino }));
      expect(closeFaults).toBe(1);
      expect(lstatSync(paths.state).ino).toBe(before.ino);
      expect(readdirSync(paths.directory)).toHaveLength(primary === "TOO_LARGE" ? 33 : 1);
      expect(readFaults).toBe(primary === "EIO" ? 1 : 0);
      expect(actual).toMatchObject({ code: primary === "EIO" ? "IO_UNAVAILABLE" : "TOO_LARGE" });
    });
  }
}

for (const phase of ["pre_mkdir", "post_mkdir_lstat"] as const) {
  for (const api of ["read", "commit", "mutate", "recover"] as const) {
    it(`snapshot_acquisition_phase_${phase}_api_${api}`, async () => {
      const workspace = mkdtempSync(join(tmpdir(), "review-acquire-"));
      homes.push(workspace);
      const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
      const paths = partitionPaths(binding);
      await preparePartition(binding, performance.now() + 5_000);
      const seam: SnapshotSeam = phase === "pre_mkdir"
        ? { mkdir: async (path, options) => {
          if (path === paths.lock) {
            throw Object.assign(new Error("injected mkdir"), { code: "EIO" });
          }
          return mkdir(path, options);
        } }
        : { lstat: async (path) => {
          if (path === paths.lock) {
            throw Object.assign(new Error("injected lstat"), { code: "EIO" });
          }
          return lstat(path);
        } };
      const deadline = performance.now() + 5_000;
      const action = api === "read" ? readSnapshot(binding, codec, deadline, (value) => value, seam)
        : api === "commit" ? commitSnapshot(binding, codec, 0, { text: "new" }, deadline, seam)
        : api === "mutate" ? mutateSnapshot(binding, codec, 0, deadline, () => ({ text: "new" }), seam)
        : recoverSnapshot(binding, codec, deadline, seam);
      const actual = await action.then((value) => value, (error: unknown) => error);
      const retained = phase === "post_mkdir_lstat";
      console.log(JSON.stringify({ phase, api, result: { code: (actual as { code?: string }).code,
        lockReleased: (actual as { lockReleased?: boolean }).lockReleased,
        warnings: (actual as { warnings?: string[] }).warnings }, lockExists: existsSync(paths.lock),
        lockInode: existsSync(paths.lock) ? lstatSync(paths.lock).ino : null }));
      expect(actual).toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: !retained,
        warnings: retained ? ["LOCK_LEFT"] : [] });
      expect(existsSync(paths.lock)).toBe(retained);
    });
  }
}

for (const api of ["read", "commit", "mutate", "recover"] as const) {
  it(`snapshot_names_primary_DEADLINE_close_EIO_api_${api}`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "review-deadline-"));
    homes.push(workspace);
    const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
    const paths = partitionPaths(binding);
    await commitSnapshot(binding, codec, 0, { text: "old" }, performance.now() + 5_000);
    const before = lstatSync(paths.state).ino;
    let shift = 0;
    let closeFaults = 0;
    const seam: SnapshotSeam = {
      clock: () => performance.now() + shift,
      opendir: async (path) => {
        const dir = await opendir(path);
        if (path === paths.directory) {
          const read = dir.read.bind(dir);
          const close = dir.close.bind(dir);
          dir.read = async () => {
            const entry = await read();
            shift = 6_000;
            return entry;
          };
          dir.close = async () => {
            await close();
            closeFaults++;
            throw Object.assign(new Error("injected close after deadline"), { code: "EIO" });
          };
        }
        return dir;
      },
    };
    const deadline = performance.now() + 5_000;
    const action = api === "read" ? readSnapshot(binding, codec, deadline, (value) => value, seam)
      : api === "commit" ? commitSnapshot(binding, codec, 1, { text: "new" }, deadline, seam)
      : api === "mutate" ? mutateSnapshot(binding, codec, 1, deadline, () => ({ text: "new" }), seam)
      : recoverSnapshot(binding, codec, deadline, seam);
    const actual = await action.then((value) => value, (error: unknown) => error);
    console.log(JSON.stringify({ primary: "DEADLINE", api, closeFaults, result: {
      code: (actual as { code?: string }).code, lockReleased: (actual as { lockReleased?: boolean }).lockReleased,
      warnings: (actual as { warnings?: string[] }).warnings }, lockExists: existsSync(paths.lock),
      canonicalSame: lstatSync(paths.state).ino === before }));
    expect(closeFaults).toBe(1);
    expect(actual).toMatchObject({ code: "DEADLINE", lockReleased: false, warnings: ["LOCK_LEFT"] });
    expect(existsSync(paths.lock)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(before);
    expect(readdirSync(paths.directory).sort()).toEqual([".lock", "state.json"]);
  });
}

it.each(["before-install", "after-rename"] as const)("snapshot_standalone_directory_close_%s", async (phase) => {
  const { binding, paths } = await fixture();
  await commitSnapshot(binding, codec, 0, { text: "old" }, performance.now() + 5_000);
  const before = readFileSync(paths.state);
  const beforeInode = lstatSync(paths.state).ino;
  let listings = 0;
  let closeFaults = 0;
  const operation = commitSnapshot(binding, codec, 1, { text: "new" }, performance.now() + 5_000, {
    async opendir(path) {
      const dir = await opendir(path);
      if (path === paths.directory && ++listings === (phase === "before-install" ? 1 : 2)) {
        const close = dir.close.bind(dir);
        dir.close = async () => {
          await close();
          closeFaults++;
          throw Object.assign(new Error("injected standalone close"), { code: "EIO" });
        };
      }
      return dir;
    },
  });
  if (phase === "before-install") {
    await expect(operation).rejects.toMatchObject({ code: "IO_UNAVAILABLE", lockReleased: true, warnings: [] });
    expect(readFileSync(paths.state).equals(before)).toBe(true);
    expect(lstatSync(paths.state).ino).toBe(beforeInode);
  } else {
    await expect(operation).resolves.toMatchObject({ status: "written", generation: 2, durability: "synced",
      inventoryVerified: false, lockReleased: true, warnings: ["INVENTORY_UNVERIFIED"] });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).payload).toEqual({ text: "new" });
    expect(lstatSync(paths.state).ino).not.toBe(beforeInode);
  }
  expect(closeFaults).toBe(1);
  expect(readdirSync(paths.directory)).toEqual(["state.json"]);
});
});
