import { bindWorkspace } from "../../../../dist/private-store/binding.js";
import { readSnapshot } from "../../../../dist/private-store/snapshot.js";

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
const deadline = performance.now() + 5_000;
const binding = await bindWorkspace(process.argv[2], "memory-v1", deadline);
const result = await readSnapshot(binding, codec, deadline, (value) => value);
process.stdout.write(JSON.stringify(result.status === "read"
  ? { status: result.status, generation: result.generation, value: JSON.parse(result.output.toString()) }
  : result));
