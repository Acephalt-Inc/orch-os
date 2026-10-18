// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { partitionPaths, type Binding } from "./binding.js";
import { errno, guarded, PrivateStoreError } from "./errors.js";
import { Budget, MAX_INPUT_BYTES, type TestSeam } from "./limits.js";
const admitted = new WeakSet<FileHandle>();
const absent = Object.freeze({ kind: "absent" as const });
async function checkedOpen(path: string, directory: boolean, budget: Budget): Promise<FileHandle | undefined> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0);
  let handle: FileHandle;
  try {
    handle = await budget.io(() => (budget.seam.open ?? open)(path, budget.seam.flags?.(flags) ?? flags), (value) => value.close());
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await budget.io(() => handle.stat());
    if (info.uid !== (budget.seam.uid?.() ?? process.getuid!()) || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)) {
      throw new PrivateStoreError("UNSAFE_PATH");
    }
    if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) throw new PrivateStoreError("UNSAFE_PATH");
    return handle;
  } catch (error) {
    await Promise.resolve().then(() => handle.close()).finally(() => budget.check());
    throw error;
  }
}
async function partition(binding: Binding, budget: Budget, create: boolean): Promise<boolean> {
  const { directory } = partitionPaths(binding, budget.seam);
  const folders = [dirname(dirname(dirname(directory))), dirname(dirname(directory)), dirname(directory), directory];
  for (const path of folders) {
    let handle = await checkedOpen(path, true, budget);
    if (!handle && create) {
      try {
        await budget.io(() => (budget.seam.mkdir ?? mkdir)(path, { mode: 0o700 }));
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      handle = await checkedOpen(path, true, budget);
      if (!handle) throw new PrivateStoreError("IO_UNAVAILABLE");
    }
    if (!handle) return false;
    await Promise.resolve().then(() => handle.close()).finally(() => budget.check());
  }
  budget.check();
  return true;
}
export async function inspectPartition(binding: Binding, deadline: number, seam: TestSeam = {}) {
  return guarded(async () => (await partition(binding, new Budget(deadline, seam), false)) ? { kind: "present" as const } : absent);
}
export async function preparePartition(binding: Binding, deadline: number, seam: TestSeam = {}) {
  return guarded(async () => (await partition(binding, new Budget(deadline, seam), true)) ? { kind: "present" as const } : absent);
}
export async function openPrivateFile(binding: Binding, name: string, deadline: number, seam: TestSeam = {}) {
  return guarded(async () => {
    const budget = new Budget(deadline, seam);
    if (name !== "state.json") throw new PrivateStoreError("BAD_INPUT");
    if (!(await partition(binding, budget, false))) return absent;
    const handle = await checkedOpen(partitionPaths(binding, seam).state, false, budget);
    if (!handle) return absent;
    admitted.add(handle);
    return { kind: "present" as const, handle };
  });
}
export async function readBounded(handle: FileHandle, cap: number, deadline: number, seam: TestSeam = {}): Promise<Buffer> {
  return guarded(async () => {
    const budget = new Budget(deadline, seam);
    if (!admitted.has(handle)) throw new PrivateStoreError("BAD_BINDING");
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > MAX_INPUT_BYTES) throw new PrivateStoreError("BAD_INPUT");
    admitted.delete(handle);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const buffer = Buffer.alloc(Math.min(8_192, cap - total + 1));
        let bytesRead: number;
        try {
          ({ bytesRead } = await budget.io(() => seam.read ? seam.read(handle, buffer) : handle.read(buffer, 0, buffer.length, null)));
        } catch (error) {
          if (errno(error) === "EINTR") continue;
          throw error;
        }
        total += bytesRead;
        if (total > cap) throw new PrivateStoreError("TOO_LARGE");
        if (!bytesRead) return Buffer.concat(chunks, total);
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } finally {
      try {
        await handle.close();
      } finally {
        budget.check();
      }
    }
  });
}
