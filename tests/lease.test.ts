// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as U from "../src/util.js";
import { LockLostError } from "../src/lock.js";
import { Lease, LeaseFileError } from "../src/lease.js";
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
    for (const action of ["status", "acquire", "renew", "release"]) {
      const [code, r] = lease().run(action, action === "status" ? null : "a", { now: 1000 });
      expect([code, r.status, r.file]).toEqual([6, "UNKNOWN", lease().path]);
    }
    expect(readdirSync(ctx.home)).toEqual(["lease.json"]);
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

  it("bad_action_and_missing_session_throw", () => {
    expect(() => lease().run("steal", "a")).toThrow(RangeError);
    expect(() => lease().run("acquire", "")).toThrow(RangeError);
  });
});


describe("OwnershipSafety", () => {
  const ctx = useTmpHome();
  const lease = () => new Lease(`${ctx.home}/lease.json`);
  const record = () => JSON.parse(readFileSync(lease().epochPath, "utf8"));

  it.each(["{not json", "null", "[]", "7", "{}", '{"epoch":7}'])("damaged_lease_blocks_every_action: %s", (text) => {
    writeFileSync(lease().path, text);
    expect(() => lease().load()).toThrow(LeaseFileError);
    for (const action of ["status", "acquire", "renew", "release"]) {
      for (const force of [false, true]) {
        const [code, r] = lease().run(action, action === "status" ? null : "old", { force, now: 1000 });
        expect([code, r.status, r.file]).toEqual([6, "CORRUPT", lease().path]);
        expect(readFileSync(lease().path, "utf8")).toBe(text);
        expect(existsSync(lease().epochPath)).toBe(false);
      }
    }
  });

  it.each(["corrupt", "unreadable"])("explicit_recovery_uses_epoch_7_record_and_journals: %s", (kind) => {
    writeFileSync(lease().path, JSON.stringify({ epoch: 7, session_id: "old", state: "ACTIVE", lease_expires_at: 5000 }));
    expect(lease().run("renew", "old", { now: 1000 })[0]).toBe(0); // backfill a legacy record
    expect(record().epoch).toBe(7);
    rmSync(lease().path);
    if (kind === "corrupt") writeFileSync(lease().path, "{truncated");
    else mkdirSync(lease().path);
    expect(lease().run("acquire", "new", { force: true, now: 1001 })[0]).toBe(6);
    const [code, r] = lease().run("acquire", "new", { recover: true, now: 1001 });
    expect([code, r.state.epoch]).toEqual([0, 8]);
    expect(record().epoch).toBe(8);
    const lines = readFileSync(lease().journalPath, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    expect(lines.map((x) => x.stage)).toEqual(["PREPARED", "COMMITTED"]);
    expect(lines[1]).toMatchObject({ file: lease().path, found: { status: kind === "corrupt" ? "CORRUPT" : "UNKNOWN" }, written: { epoch: 8, session_id: "new" } });
    expect(existsSync(lines[1].evidence)).toBe(true);
    if (kind === "corrupt") expect(readFileSync(lines[1].evidence, "utf8")).toBe("{truncated");
  });

  it("recovery_without_an_epoch_floor_refuses_without_moving_evidence", () => {
    writeFileSync(lease().path, "{broken");
    const [code, r] = lease().run("acquire", "new", { recover: true });
    expect(code).toBe(6);
    expect(r.error).toContain("last epoch unknown");
    expect(readdirSync(ctx.home)).toEqual(["lease.json"]);
    expect(readFileSync(lease().path, "utf8")).toBe("{broken");
  });

  it("readable_epoch_in_a_damaged_legacy_object_can_supply_the_floor", () => {
    writeFileSync(lease().path, '{"epoch":7}');
    expect(lease().run("acquire", "new", { recover: true })[1].state.epoch).toBe(8);
  });

  it.each(["{", "{}", '{"epoch":-1,"holders":[]}', '{"epoch":9007199254740992,"holders":[]}'])("bad_epoch_record_never_resets_even_for_a_valid_lease: %s", (text) => {
    lease().run("acquire", "old", { now: 1000 });
    const before = readFileSync(lease().path, "utf8");
    writeFileSync(lease().epochPath, text);
    for (const action of ["status", "acquire", "renew", "release"]) {
      const [code, r] = lease().run(action, action === "status" ? null : "old", { now: 1001 });
      expect([code, r.status, r.file]).toEqual([6, "CORRUPT", lease().epochPath]);
      expect(readFileSync(lease().path, "utf8")).toBe(before);
    }
  });

  it.each(["lease", "record"])("dangling_symlink_is_unknown: %s", (kind) => {
    const path = kind === "lease" ? lease().path : lease().epochPath;
    symlinkSync(`${ctx.home}/missing`, path);
    expect(lease().run("acquire", "new", { recover: true })[0]).toBe(6);
    expect(existsSync(lease().journalPath)).toBe(false);
  });

  it("a_crash_before_lease_publication_reserves_the_epoch_first", () => {
    lease().run("acquire", "old", { now: 1000 });
    const write = U.atomicWrite;
    const spy = vi.spyOn(U, "atomicWrite").mockImplementation((path, data, opts) => {
      if (path === lease().path) {
        expect(record().epoch).toBe(2); // kills the old record-after-lease mutation
        throw new Error("crash before lease publication");
      }
      write(path, data, opts);
    });
    try { expect(() => lease().run("acquire", "new", { force: true, now: 1001 })).toThrow("crash before lease publication"); }
    finally { spy.mockRestore(); }
    expect(lease().load().epoch).toBe(1);
    expect(lease().run("acquire", "next", { force: true, now: 1002 })[1].state.epoch).toBe(3);
  });

  it("recovery_crash_after_rename_does_not_restart_or_reuse_the_reserved_epoch", () => {
    lease().run("acquire", "old", { now: 1000 });
    writeFileSync(lease().path, "{broken");
    mkdirSync(lease().path + ".tmp"); // fail lease publication after record + journal + rename
    expect(() => lease().run("acquire", "new", { recover: true, now: 1001 })).toThrow();
    expect(record().epoch).toBe(2);
    expect(existsSync(lease().path)).toBe(false);
    rmSync(lease().path + ".tmp", { recursive: true });
    expect(lease().run("acquire", "next", { now: 1002 })[1].state.epoch).toBe(3);
    expect(readFileSync(lease().journalPath, "utf8")).toContain('"stage":"PREPARED"');
  });

  it("stores_on_renew_and_release_keep_the_high_water_mark", () => {
    lease().run("acquire", "a", { now: 1000 });
    for (const action of ["renew", "release"]) {
      rmSync(lease().epochPath);
      expect(lease().run(action, "a", { now: 1001 })[0]).toBe(0);
      expect(record().epoch).toBe(1);
    }
    rmSync(lease().path);
    expect(lease().run("acquire", "b", { now: 1002 })[1].state.epoch).toBe(2);
  });

  it("lost_lock_rejects_lease_and_epoch_store_before_effect", () => {
    lease().run("acquire", "old", { now: 1000 });
    const leaseBytes = readFileSync(lease().path, "utf8");
    const recordBytes = readFileSync(lease().epochPath, "utf8");
    const write = U.atomicWrite;
    const spy = vi.spyOn(U, "atomicWrite").mockImplementation((path, data, opts) => {
      if (path === lease().epochPath) {
        const file = lease().lock + "/owner.json";
        const owner = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify({ ...owner, token: "new owner" }));
      }
      write(path, data, opts);
    });
    try { expect(() => lease().run("acquire", "new", { force: true, now: 1001 })).toThrow(LockLostError); }
    finally { spy.mockRestore(); }
    expect(readFileSync(lease().path, "utf8")).toBe(leaseBytes);
    expect(readFileSync(lease().epochPath, "utf8")).toBe(recordBytes);
  });

  it("epoch_exhaustion_refuses_before_writing", () => {
    writeFileSync(lease().epochPath, JSON.stringify({ epoch: Number.MAX_SAFE_INTEGER, holders: [] }));
    expect(lease().run("acquire", "a")[0]).toBe(6);
    expect(existsSync(lease().path)).toBe(false);
  });
});
