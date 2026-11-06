import { bindWorkspace } from "../../../../dist/private-store/binding.js";
import { commitSnapshot } from "../../../../dist/private-store/snapshot.js";
import { mkdir, open, rename } from "node:fs/promises";

const [workspace, phase, expected] = process.argv.slice(2);
const deadline = performance.now() + 5_000;
const binding = await bindWorkspace(workspace, "memory-v1", deadline);
const stop = async (name) => {
  if (name !== phase) return;
  await new Promise((resolve, reject) => process.stdout.write(`BARRIER:${name}\n`, (error) => error ? reject(error) : resolve()));
  await new Promise(() => {});
};
let firstWrite = true;
await commitSnapshot(binding, {
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "text" || typeof value.text !== "string") throw new Error("invalid payload");
    return { text: value.text };
  },
  encode(value) { return value; },
}, Number(expected), { text: `installed-${phase}` }, deadline, {
  async mkdir(path, options) {
    await mkdir(path, options);
    if (path.endsWith("/.lock")) await stop("lock");
  },
  async open(path, flags, mode) {
    const handle = await open(path, flags, mode);
    if (path.endsWith(".tmp")) await stop("temp-open");
    return handle;
  },
  async write(handle, bytes, offset) {
    const result = await handle.write(bytes, offset, Math.min(bytes.length - offset, 5), offset);
    if (firstWrite) {
      firstWrite = false;
      await stop("partial-temp");
    }
    return result;
  },
  async sync(handle) {
    await handle.sync();
    const info = await handle.stat();
    await stop(info.isDirectory() ? "folder-flushed" : "temp-flushed");
  },
  async rename(source, target) {
    await stop("before-rename");
    await rename(source, target);
    await stop("after-rename");
  },
});
