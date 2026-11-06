// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Guard for tests/_yield.setup.ts. The tests in each block run in order; each one checks what the
// event loop did after the test or hook before it. They fail when the setup file is no longer
// listed in `setupFiles`.
import { beforeAll, describe, expect, it } from "vitest";

describe("EventLoopYield", () => {
  let ran = 0;
  const queue = () => { setImmediate(() => { ran += 1; }); };

  it("a synchronous test queues a callback and returns before it runs", () => {
    queue();
    expect(ran).toBe(0);
  });

  it("the queued callback ran before the next synchronous test started", () => {
    expect(ran).toBe(1);
    queue();
  });

  it("the event loop turned again after the second synchronous test", () => {
    expect(ran).toBe(2);
  });
});

// after the loop was held for longer than the setup file's threshold (500 ms), it runs for a
// while and not for one turn only: a timer that became due after the hold has fired
describe("EventLoopWait", () => {
  const HOLD_MS = 600;
  const SOON_MS = 5;
  let afterHook = false;
  let afterTest = false;
  // blocks this thread the way spawnSync does, without using a processor
  const hold = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS); };

  beforeAll(() => {
    hold();
    setTimeout(() => { afterHook = true; }, SOON_MS);
  });

  it("a timer queued at the end of a long synchronous hook fired before the first test started", () => {
    expect(afterHook).toBe(true);
  });

  it("a long synchronous test queues a timer at its end and returns before it fires", () => {
    hold();
    setTimeout(() => { afterTest = true; }, SOON_MS);
    expect(afterTest).toBe(false);
  });

  it("that timer fired before the next test started", () => {
    expect(afterTest).toBe(true);
  });
});
