// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { lstat, mkdir, open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { PrivateStoreError } from "./errors.js";
export const MAX_BUDGET_MS = 5_000;
export const DEFAULT_INPUT_BYTES = 256 * 1_024;
export const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
export interface TestSeam {
  platform?: () => NodeJS.Platform;
  uid?: () => number;
  clock?: () => number;
  uuid?: () => string;
  lstat?: typeof lstat;
  realpath?: typeof realpath;
  statfs?: typeof statfs;
  mkdir?: typeof mkdir;
  open?: typeof open;
  flags?: (flags: number) => number;
  read?: (handle: FileHandle, buffer: Buffer) => Promise<{ bytesRead: number }>;
}
const seamKeys = new Set(["platform", "uid", "clock", "uuid", "lstat", "realpath", "statfs", "mkdir", "open", "flags", "read"]);
export function gate(seam: TestSeam): void {
  if (!seam || typeof seam !== "object" || Array.isArray(seam)) throw new PrivateStoreError("BAD_INPUT");
  if (Object.entries(seam).some(([key, value]) => !seamKeys.has(key) || typeof value !== "function")) {
    throw new PrivateStoreError("BAD_INPUT");
  }
  if (process.platform === "win32" || seam.platform?.() === "win32") throw new PrivateStoreError("PRIVACY_UNAVAILABLE");
}
export class Budget {
  constructor(readonly deadline: number, readonly seam: TestSeam) {
    gate(seam);
    const now = (seam.clock ?? performance.now.bind(performance))();
    if (!Number.isFinite(deadline) || deadline > now + MAX_BUDGET_MS) throw new PrivateStoreError("BAD_INPUT");
    this.check();
  }
  check(): void {
    if ((this.seam.clock ?? performance.now.bind(performance))() >= this.deadline) throw new PrivateStoreError("DEADLINE");
  }
  async io<T>(action: () => Promise<T>, release?: (value: T) => Promise<void>): Promise<T> {
    this.check();
    let value: T;
    try {
      value = await action();
    } catch (error) {
      this.check();
      throw error;
    }
    try {
      this.check();
    } catch (error) {
      await Promise.resolve().then(() => release?.(value)).catch(() => undefined);
      throw error;
    }
    return value;
  }
}
