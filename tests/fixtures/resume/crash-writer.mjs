// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test fixture. Runs one write through the built store and kills its own process, with no cleanup,
// when the write reaches the named point.
// Usage: node crash-writer.mjs STORE_MODULE WORKSPACE EXPECTED_REVISION POINT [NOTE_JSON]
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [store, workspace, revision, point, note] = process.argv.slice(2);
const { write } = await import(pathToFileURL(store).href);

write(workspace, Number(revision), note === undefined ? undefined : JSON.parse(note), {
  at(reached) {
    if (reached !== point) return;
    writeSync(1, `reached ${reached}\n`);
    process.kill(process.pid, "SIGKILL");
    // The kill normally lands before this line. The wait is bounded so the fixture cannot hang.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    process.exit(97);
  },
});
// The write finished: the named point was never reached.
process.exit(98);
