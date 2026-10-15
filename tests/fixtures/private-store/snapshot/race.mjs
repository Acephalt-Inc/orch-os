import { bindWorkspace } from "../../../../dist/private-store/binding.js";
import { commitSnapshot } from "../../../../dist/private-store/snapshot.js";

const [workspace, text] = process.argv.slice(2);
const codec = {
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "text" || typeof value.text !== "string") {
      throw new Error("invalid payload");
    }
    return { text: value.text };
  },
  encode(value) { return value; },
};
const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5_000);
await new Promise((resolve, reject) => process.stdout.write("READY\n", (error) => error ? reject(error) : resolve()));
await new Promise((resolve) => process.stdin.once("data", resolve));
try {
  const result = await commitSnapshot(binding, codec, 0, { text }, performance.now() + 5_000);
  process.stdout.write(JSON.stringify({ status: result.status, generation: result.status === "written" ? result.generation : null }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code }) + "\n");
}
