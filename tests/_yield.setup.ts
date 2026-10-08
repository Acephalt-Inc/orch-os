// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Loaded for each test file through `setupFiles` in vitest.config.ts.
// Many tests here block on spawnSync. Vitest does not return to the event loop between two
// synchronous tests, so a file with enough of them keeps the worker from answering the runner
// and the run ends with `Timeout calling "onTaskUpdate"`. One turn of the loop after each test
// lets the worker's timers and messages through. tests/event-loop.test.ts fails without it.
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
