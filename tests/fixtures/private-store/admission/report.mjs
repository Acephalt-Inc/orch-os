// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { bindWorkspace } from "../../../../dist/private-store/binding.js";
let report;
try {
  await bindWorkspace({ approval: true }, "memory-v1", performance.now() + 5_000);
  report = { unexpected: true };
} catch (error) {
  report = { code: error.code, message: error.message };
}
const output = Buffer.from(JSON.stringify(report) + "\n" + "x".repeat(200_000));
let deliveryError;
process.stdout.on("error", (error) => { deliveryError = error; });
async function write(bytes) {
  await new Promise((done, reject) => process.stdout.write(bytes, (error) => error ? reject(error) : done()));
}
try {
  await write(output.subarray(0, 100));
  if (process.argv[2] === "pause") {
    await new Promise((done) => process.stderr.write("first 100 delivered\n", done));
    await new Promise((done) => process.stdin.once("data", done));
  }
  await write(output.subarray(100));
  if (deliveryError) throw deliveryError;
} catch {
  await new Promise((done) => process.stderr.write("output failed\n", done));
  process.exitCode = 74;
}
