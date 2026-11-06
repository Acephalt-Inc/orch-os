// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/** Run with one output attached to a pipe that has no reader before the child starts. */
export function withClosedReader(args: string[], stream: "stdout" | "stderr", env = process.env): SpawnSyncReturns<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "orch-closed-reader-"));
  const fifo = join(dir, "pipe");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
  const anchor = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  closeSync(anchor);
  rmSync(dir, { recursive: true, force: true });
  try {
    const stdio = stream === "stdout" ? ["ignore", writer, "pipe"] : ["ignore", "pipe", writer];
    return spawnSync(process.execPath, args, { env, stdio, timeout: 5000 });
  } finally {
    closeSync(writer);
  }
}
