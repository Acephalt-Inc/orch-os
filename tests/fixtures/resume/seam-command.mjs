// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Test fixture. Runs the built command in this process with a test seam in which removing the
// writer lock fails. The command's own output and exit status are left as they are.
// Usage: node seam-command.mjs COMMAND_MODULE WHEN ARGUMENT...
//   WHEN is "after-rename": removal fails only once the new record has replaced the old one;
//   "always": removal fails every time; or "folder-flush": opening the folder for its flush fails.
import { rmdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [command, when, ...argv] = process.argv.slice(2);
const { main } = await import(pathToFileURL(command).href);

let renamed = false;
process.exitCode = await main(argv, {
  at(point) { if (point === "renamed") renamed = true; },
  ...(when === "folder-flush" ? { openDirectory() { throw Object.assign(new Error("the folder cannot be opened here"), { code: "EPERM" }); } } : {}),
  removeLock(path) {
    if (when === "always" || (when === "after-rename" && renamed)) throw Object.assign(new Error("the lock folder cannot be removed here"), { code: "EPERM" });
    rmdirSync(path);
  },
});
