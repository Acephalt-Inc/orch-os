// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test fixture. Runs one set through the built store and kills its own process, with no cleanup,
// when the change reaches the named point.
// Usage: node crash-writer.mjs STORE_MODULE WORKSPACE KEY VALUE EXPECTED_REVISION POINT
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [store, workspace, key, value, revision, point] = process.argv.slice(2);
const { setPreference } = await import(pathToFileURL(store).href);

await setPreference(workspace, key, value, Number(revision), Date.now(), {
  at(reached) {
    if (reached !== point) return;
    writeSync(1, `reached ${reached}\n`);
    process.kill(process.pid, "SIGKILL");
    // The kill normally lands before this line. The wait is bounded so the fixture cannot hang.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    process.exit(97);
  },
});
// The change finished: the named point was never reached.
process.exit(98);
