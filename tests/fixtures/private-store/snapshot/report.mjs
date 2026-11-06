import { bindWorkspace } from "../../../../dist/private-store/binding.js";
import { commitSnapshot, readSnapshot } from "../../../../dist/private-store/snapshot.js";

const codec = {
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "text" || typeof value.text !== "string") throw new Error("invalid payload");
    return { text: value.text };
  },
  encode(value) { return value; },
};
const binding = await bindWorkspace(process.argv[2], "memory-v1", performance.now() + 5_000);
const written = await commitSnapshot(binding, codec, 0, { text: "installed" }, performance.now() + 5_000);
const report = JSON.stringify({ written, padding: "x".repeat(256 * 1024) }) + "\n";
let outputFailure = false;
process.stdout.on("error", () => { outputFailure = true; });
async function deliver(bytes) {
  return new Promise((resolve) => process.stdout.write(bytes, (error) => {
    if (error) outputFailure = true;
    resolve();
  }));
}
await deliver(report.slice(0, 100));
process.stderr.write("PREFIX_READY\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
for (let offset = 100; offset < report.length && !outputFailure; offset += 16 * 1024) {
  await deliver(report.slice(offset, offset + 16 * 1024));
}
const saved = await readSnapshot(binding, codec, performance.now() + 5_000, (value) => value);
process.stderr.write(`${JSON.stringify({ outputFailure, savedGeneration: saved.generation,
  warnings: written.status === "written" ? written.warnings : [] })}\n`);
process.exitCode = outputFailure ? 1 : 0;
