// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Positive control for probe.mjs: makes one file read, one file write, one local connection
// attempt and one process launch, through named imports as program code would.
// Usage: node control.mjs <file to read> <file to write> <local socket path nobody listens on>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const [readPath, writePath, socketPath] = process.argv.slice(2);

readFileSync(readPath, "utf8");
writeFileSync(writePath, "control\n");
// A local socket path with no listener: the attempt fails without leaving the machine.
connect({ path: socketPath }).on("error", () => {});
spawnSync(process.execPath, ["-e", ""], { timeout: 20_000 });
