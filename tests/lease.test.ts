// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Lease } from "../src/lease.js";
import { useTmpHome } from "./_helpers.js";

describe("LeaseTest", () => {
  const ctx = useTmpHome();
  const lease = () => new Lease(`${ctx.home}/lease.json`, 3600, 60);

  it("test_acquire_then_status", () => {
    let [code, r] = lease().run("acquire", "a", { now: 1000 });
    expect([code, r.status, r.state.epoch]).toEqual([0, "ACQUIRED", 1]);
    [code, r] = lease().run("status", null, { now: 1001 });
    expect(r.status).toBe("HELD");
  });

  it("test_unexpired_holder_blocks_other_acquire", () => {
    lease().run("acquire", "a", { now: 1000 });
    const [code, r] = lease().run("acquire", "b", { now: 1010 });
    expect([code, r.status]).toEqual([3, "BUSY"]);
  });

  it("test_force_takeover_bumps_epoch", () => {
    lease().run("acquire", "a", { now: 1000 });
    const [code, r] = lease().run("acquire", "b", { force: true, now: 1010 });
    expect([code, r.state.epoch, r.state.forced_takeover]).toEqual([0, 2, true]);
  });

  it("test_expired_lease_is_acquirable", () => {
    lease().run("acquire", "a", { leaseSeconds: 60, now: 1000 });
    const [code, r] = lease().run("acquire", "b", { now: 1061 });
    expect([code, r.state.previous_owner]).toEqual([0, "a"]);
  });

  it("test_short_duration_is_raised_to_minimum", () => {
    let [code, r] = lease().run("acquire", "a", { leaseSeconds: 0, now: 1000 });
    expect(r.lease_seconds_raised).toBe(true);
    expect(r.state.lease_expires_at).toBe(1060);
    [code] = lease().run("acquire", "b", { leaseSeconds: 0, now: 1030 });
    expect(code).toBe(3);
  });

  it("test_renew_rules", () => {
    lease().run("acquire", "a", { now: 1000 });
    expect(lease().run("renew", "b", { now: 1001 })[0]).toBe(4);
    expect(lease().run("renew", "a", { expectedEpoch: 9, now: 1001 })[1].status).toBe("STALE_EPOCH");
    const [code, r] = lease().run("renew", "a", { expectedEpoch: 1, now: 2000 });
    expect([code, r.state.lease_expires_at]).toEqual([0, 5600]);
    expect(lease().run("renew", "a", { now: 99999 })[1].status).toBe("EXPIRED");
  });

  it("test_release_then_other_acquires", () => {
    lease().run("acquire", "a", { now: 1000 });
    expect(lease().run("release", "b", { now: 1001 })[0]).toBe(4);
    expect(lease().run("release", "a", { now: 1001 })[1].status).toBe("RELEASED");
    expect(lease().run("acquire", "b", { now: 1002 })[0]).toBe(0);
  });
});

describe("LeaseV2", () => {
  const ctx = useTmpHome();
  const lease = () => new Lease(`${ctx.home}/lease.json`, 3600, 60);

  it("an_unreadable_lease_file_fails_closed_instead_of_reading_as_free", () => {
    mkdirSync(`${ctx.home}/lease.json`); // EISDIR on read
    expect(() => lease().run("acquire", "a", { now: 1000 })).toThrow(/EISDIR/);
    expect(() => lease().run("status", null, { now: 1000 })).toThrow(/EISDIR/);
  });

  it("release_with_expected_epoch_is_fenced", () => {
    lease().run("acquire", "a", { now: 1000 });
    const [code, r] = lease().run("release", "a", { expectedEpoch: 7, now: 1001 });
    expect([code, r.status]).toEqual([4, "STALE_EPOCH"]);
    expect(lease().run("release", "a", { expectedEpoch: 1, now: 1002 })[1].status).toBe("RELEASED");
  });


  it("writes_the_v1_file_layout", () => {
    lease().run("acquire", "a", { now: 1000.5 });
    expect(readFileSync(`${ctx.home}/lease.json`, "utf8")).toBe(
      '{"acquired_at": 1000.5, "previous_owner": null, "epoch": 1, "state": "ACTIVE", "session_id": "a", ' +
      '"heartbeat": 1000.5, "lease_seconds": 3600, "lease_expires_at": 4600.5}');
  });

  it("reads_a_lease_file_written_by_v1", () => {
    // byte-for-byte what the Python version wrote for: acquire "old" at t=1000.25
    writeFileSync(`${ctx.home}/lease.json`, '{"acquired_at": 1000.25, "previous_owner": null, "epoch": 3, ' +
      '"state": "ACTIVE", "session_id": "old", "heartbeat": 1000.25, "lease_seconds": 3600, "lease_expires_at": 4600.25}');
    expect(lease().run("status", null, { now: 2000 })[1].status).toBe("HELD");
    expect(lease().run("acquire", "new", { now: 2000 })[0]).toBe(3);
    const [code, r] = lease().run("renew", "old", { expectedEpoch: 3, now: 2000 });
    expect([code, r.state.epoch]).toEqual([0, 3]);
  });

  it("corrupt_file_reads_as_free", () => {
    writeFileSync(`${ctx.home}/lease.json`, "{not json");
    expect(lease().run("status", null, { now: 1 })[1].status).toBe("FREE");
    expect(lease().run("acquire", "a", { now: 1 })[1].state.epoch).toBe(1);
  });

  it("bad_action_and_missing_session_throw", () => {
    expect(() => lease().run("steal", "a")).toThrow(RangeError);
    expect(() => lease().run("acquire", "")).toThrow(RangeError);
  });
});
