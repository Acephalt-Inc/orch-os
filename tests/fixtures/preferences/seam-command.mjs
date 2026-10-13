// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test fixture. Runs the built command in this process with a test seam in which removing the
// writer lock fails. The command's own output and exit status are left as they are.
// Usage: node seam-command.mjs COMMAND_MODULE WHEN ARGUMENT...
//   WHEN is "after-rename": removal fails only once the new state has replaced the old one;
//   or "always": removal fails every time.
import { rmdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [command, when, ...argv] = process.argv.slice(2);
const { runPreferenceCommand } = await import(pathToFileURL(command).href);

let renamed = false;
process.exitCode = await runPreferenceCommand(argv, {
  at(point) { if (point === "renamed") renamed = true; },
  async openDirectory(path) {
    if (when === "directory-flush") throw Object.assign(new Error("the folder cannot be flushed here"), { code: "EPERM" });
    return (await import("node:fs/promises")).open(path, "r");
  },
  async removeLock(path) {
    if (when === "always" || (when === "after-rename" && renamed)) throw Object.assign(new Error("the lock folder cannot be removed here"), { code: "EPERM" });
    await rmdir(path);
  },
});
