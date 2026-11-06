// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Positive control for tests/fixtures/learning/probe.mjs: one call of each kind the probe is
// meant to record, made the way compiled program code makes them (named imports). A probe that
// misses any of these would also miss it in the program under test.
//
// usage: node --import probe.mjs probe-control.mjs <scratch directory>
// Nothing here leaves the machine: the socket path does not exist and the URL is a data URL.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
const file = join(dir, "control.txt");

writeFileSync(file, "control");
readFileSync(file);
await readFile(file);
spawnSync(process.execPath, ["--version"]);
homedir();
void process.env.LEARNING_CONTROL_CANARY;
await fetch("data:text/plain,control");
await new Promise((resolve) => {
  const socket = createConnection({ path: join(dir, "no-such-socket") });
  socket.on("error", resolve);
  socket.on("connect", resolve);
});
process.stdout.write(`now=${new Date().toISOString()}\n`);
