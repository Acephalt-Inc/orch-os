// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { open } from "node:fs/promises";
await new Promise((done) => process.stdout.write("ready\n", done));
await new Promise((done) => setTimeout(done, 400));
const handle = await open(process.argv[2], "w");
await handle.close();
