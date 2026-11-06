// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Loaded for each test file through `setupFiles` in vitest.config.ts.
// Many tests here block on spawnSync. Vitest does not return to the event loop between two
// synchronous tests, so a file with enough of them keeps the worker from answering the runner
// and the run ends with `Timeout calling "onTaskUpdate"`. tests/event-loop.test.ts fails without
// the two things done here.
// 1. One turn of the loop after each test: timers that are due run, and a waiting message is read.
// 2. A timed wait once the loop has been held for HELD_MS or longer, before a test (this covers a
//    long synchronous `beforeAll`) and after it. One turn does not wait for anything, and on
//    Windows it reads at most one message from the runner, so in a file of long synchronous tests
//    the replies are read several tests late; a reply read 60 s after its request ends the run.
//    While the timer is pending the loop waits for messages and reads each one as it arrives.
//    The wait is SHARE of the time the loop was held, at most LONGEST_MS. That stays under the
//    100 ms the runner leaves between two updates, so no second update follows the wait and then
//    goes unanswered through the next test.
import { afterEach, beforeEach } from "vitest";

const HELD_MS = 500;
const SHARE = 0.02;
const LONGEST_MS = 50;
// the real functions, taken before a test can replace them with fake ones
const { setImmediate: turn, setTimeout: wait } = globalThis;
const now = performance.now.bind(performance);
let free = now();

async function letTheLoopRun(): Promise<void> {
  const held = now() - free;
  if (held < HELD_MS) return;
  await new Promise<void>((resolve) => wait(resolve, Math.min(held * SHARE, LONGEST_MS)));
  free = now();
}

beforeEach(letTheLoopRun);

afterEach(async () => {
  await new Promise<void>((resolve) => turn(resolve));
  await letTheLoopRun();
});
