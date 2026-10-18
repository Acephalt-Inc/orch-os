import { existsSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindWorkspace, partitionPaths } from "../src/private-store/binding.js";
import { preparePartition } from "../src/private-store/privacy.js";
import { commitSnapshot, readSnapshot, recoverSnapshot, type SnapshotCodec } from "../src/private-store/snapshot.js";

describe.skipIf(process.platform === "win32")("POSIX private-store recovery", () => {

const homes: string[] = [];
const codec: SnapshotCodec<{ text: string }> = {
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "text" || typeof (value as { text: unknown }).text !== "string") {
      throw new Error("invalid payload");
    }
    return { text: (value as { text: string }).text };
  },
  encode(value) { return value; },
};
const tempName = `.state-12345678-1234-4123-8123-123456789abc.tmp`;
async function fixture(committed: boolean) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "snapshot-recovery-"));
  homes.push(workspace);
  const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
  const paths = partitionPaths(binding);
  if (committed) await commitSnapshot(binding, codec, 0, { text: "canonical" }, performance.now() + 5_000);
  else await preparePartition(binding, performance.now() + 5_000);
  return { binding, paths };
}
afterEach(() => {
  for (const path of homes) rmSync(path, { recursive: true, force: true });
  homes.length = 0;
});

it("snapshot_recovery_uses_canonical_state_only", async () => {
  for (const committed of [false, true]) {
    const { binding, paths } = await fixture(committed);
    const temp = join(paths.directory, tempName);
    writeFileSync(temp, "uncommitted", { mode: 0o600 });
    const before = committed ? readFileSync(paths.state) : undefined;
    // K2.11: A recognized leftover temp blocks reads and commits until explicit recovery.
    await expect(readSnapshot(binding, codec, performance.now() + 5_000))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(commitSnapshot(binding, codec, committed ? 1 : 0, { text: "retry" }, performance.now() + 5_000))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(readFileSync(temp, "utf8")).toBe("uncommitted");
    expect(await recoverSnapshot(binding, codec, performance.now() + 5_000))
      .toMatchObject({ status: "recovered", generation: committed ? 1 : 0, discardedTemps: 1 });
    expect(existsSync(temp)).toBe(false);
    if (before) expect(readFileSync(paths.state).equals(before)).toBe(true);
    else expect(existsSync(paths.state)).toBe(false);
  }

  for (const kind of ["unknown", "symlink", "hardlink", "corrupt"]) {
    const { binding, paths } = await fixture(true);
    const safeTemp = join(paths.directory, ".state-87654321-4321-4321-8321-abcdefabcdef.tmp");
    writeFileSync(safeTemp, "safe", { mode: 0o600 });
    const canonical = readFileSync(paths.state);
    const suspect = join(paths.directory, tempName);
    if (kind === "unknown") writeFileSync(join(paths.directory, "state.json.bak"), "sentinel", { mode: 0o600 });
    if (kind === "symlink") symlinkSync(paths.state, suspect);
    if (kind === "hardlink") linkSync(safeTemp, suspect);
    if (kind === "corrupt") writeFileSync(paths.state, "{broken\n");
    const entries = readdirSync(paths.directory).sort();
    const safeInode = lstatSync(safeTemp).ino;
    // K2.11: Unsafe inventory or corrupt canonical state refuses before deleting any temp.
    await expect(recoverSnapshot(binding, codec, performance.now() + 5_000))
      .rejects.toMatchObject({ code: kind === "corrupt" ? "CORRUPT_STATE" : "UNSAFE_PATH" });
    expect(readdirSync(paths.directory).sort()).toEqual(entries);
    expect(lstatSync(safeTemp).ino).toBe(safeInode);
    expect(readFileSync(safeTemp, "utf8")).toBe("safe");
    if (kind !== "corrupt") expect(readFileSync(paths.state).equals(canonical)).toBe(true);
  }

  const retry = await fixture(true);
  const retryTemp = join(retry.paths.directory, tempName);
  writeFileSync(retryTemp, "retry", { mode: 0o600 });
  let failed = false;
  await expect(recoverSnapshot(retry.binding, codec, performance.now() + 5_000, {
    async unlink(path) {
      if (!failed) { failed = true; throw Object.assign(new Error("injected"), { code: "EIO" }); }
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
    },
  })).rejects.toMatchObject({ code: "IO_UNAVAILABLE" });
  // K2.11: Failed cleanup leaves the temp intact; a second explicit recovery converges.
  expect(readFileSync(retryTemp, "utf8")).toBe("retry");
  expect(await recoverSnapshot(retry.binding, codec, performance.now() + 5_000))
    .toMatchObject({ status: "recovered", generation: 1, discardedTemps: 1 });
  expect(readdirSync(retry.paths.directory)).toEqual(["state.json"]);
});
});
