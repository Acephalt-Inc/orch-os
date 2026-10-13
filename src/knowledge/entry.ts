// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Direct module entry of the knowledge demo: process argv in, stdout/stderr and exit code out. */
import { main } from "./command.js";
import { createDemoTransport } from "./demo.js";
import { ignoreClosedPipes } from "../closed-pipe.js";

ignoreClosedPipes();

const io = {
  out: (s: string) => process.stdout.write(s),
  err: (s: string) => process.stderr.write(s),
};
const runtime = { transport: createDemoTransport(), now: () => new Date() };

process.exitCode = await main(process.argv.slice(2), io, runtime);
