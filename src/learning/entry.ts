// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Direct process entry: `node dist/learning/entry.js review < document.json`.
 *
 * Standard input is read asynchronously with a byte cap and a deadline. At the cap or at the
 * deadline the input is closed, so the process ends even when the other side never closes it.
 */
import { main } from "./command.js";
import { type ErrorCode, LearningError, MAX_BYTES } from "./schema.js";
import { ignoreClosedPipes } from "../closed-pipe.js";

ignoreClosedPipes();

/** How long to wait for standard input to end, in milliseconds. */
const STDIN_DEADLINE_MS = 4500;

/** All of standard input, or LearningError: LIMIT over the cap, TIMEOUT at the deadline. */
function readStdin(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    // Give up on the input: stop listening and close it. Pausing is not enough, because a
    // paused stream keeps reading ahead and an input that stays open would keep the process alive.
    const abandon = (code: ErrorCode) => {
      cleanup();
      stdin.destroy();
      reject(new LearningError(code));
    };
    const timer = setTimeout(() => abandon("TIMEOUT"), STDIN_DEADLINE_MS);
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        abandon("LIMIT");
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => abandon("INVALID_INPUT");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

process.exitCode = await main(
  process.argv.slice(2),
  { read: readStdin, out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  { now: () => new Date() },
);
