// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Guard for tests/_yield.setup.ts: the event loop gets a turn after each test. These tests run
// in order; each one checks that a callback queued by the test before it has already run.
// They fail when the setup file is no longer listed in `setupFiles`.
import { describe, expect, it } from "vitest";

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
