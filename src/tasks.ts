// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Task claim registry (new in v2): one lease file per task id under [tasks] dir.
 *
 * A claim is a lease on the task, with the same rules as the role lease: exactly one holder
 * while unexpired, the stored expiry decides freshness, and every change of holder bumps the
 * task's epoch (its fencing token). There is no --force: a claimed task cannot be taken from
 * its holder until the holder releases it or the claim expires. Re-claiming a task you hold
 * extends it and keeps the epoch. Exit codes match the lease: 0 / 3 BUSY / 4 NOT_HOLDER,
 * EXPIRED or STALE_EPOCH / 5 UNVERIFIED / 6 CORRUPT or UNKNOWN. Task ids are case-insensitive, so two ids that differ
 * only in case can never be two tasks on a case-insensitive file system.
 */
import { existsSync, readdirSync } from "node:fs";
import { holderHistory, Lease } from "./lease.js";
import { validName } from "./util.js";

export class TaskError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TaskError";
  }
}

const STATUS_NAMES: Record<string, string> = { ACQUIRED: "CLAIMED" };

export interface TaskRow {
  id: string;
  status: string;
  holder: string | null;
  epoch: number | null;
  expires_in: number;
}

export class Tasks {
  constructor(readonly dir: string, readonly defaultSeconds = 7200, readonly minSeconds = 60) {}

  /** Task ids are case-insensitive ("Fix-1" and "fix-1" are one task) and stored in NFC lower case. */
  static key(id: string): string {
    return id.normalize("NFC").toLowerCase();
  }

  private lease(id: string): Lease {
    if (!validName(id)) throw new TaskError(`bad task id '${id}': use letters, digits, . @ _ - (not starting with .)`);
    return new Lease(`${this.dir}/${Tasks.key(id)}.json`, this.defaultSeconds, this.minSeconds);
  }

  private run(action: string, id: string, holder: string | null, opts: { recover?: boolean; seconds?: number | null; expectedEpoch?: number | null; now?: number | null } = {}): [number, Record<string, any>] {
    if (action !== "status" && !validName(holder)) throw new TaskError(`bad holder '${holder}': use letters, digits, . @ _ -`);
    const [code, r] = this.lease(id).run(action, holder, { recover: opts.recover, leaseSeconds: opts.seconds, expectedEpoch: opts.expectedEpoch, now: opts.now, trackHolders: true });
    r.task = Tasks.key(id);
    r.status = STATUS_NAMES[r.status] ?? r.status;
    return [code, r];
  }

  claim(id: string, holder: string, opts: { recover?: boolean; seconds?: number | null; now?: number | null } = {}) {
    return this.run("acquire", id, holder, opts);
  }

  renew(id: string, holder: string, opts: { seconds?: number | null; expectedEpoch?: number | null; now?: number | null } = {}) {
    return this.run("renew", id, holder, opts);
  }

  release(id: string, holder: string, opts: { expectedEpoch?: number | null; now?: number | null } = {}) {
    return this.run("release", id, holder, opts);
  }

  status(id: string, now?: number | null) {
    return this.run("status", id, null, { now });
  }

  /** Every agent that has ever held the task, oldest first (the `holders` list; older files: previous_owner, holder). */
  holders(id: string): string[] {
    const [, r] = this.status(id);
    return holderHistory(r.state ?? {});
  }

  list(now?: number | null): TaskRow[] {
    if (!existsSync(this.dir)) return [];
    const ids = readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => f.slice(0, -5))
      .filter((id) => validName(id) && id === Tasks.key(id)).sort(); // ids are stored in lower case
    return ids.map((id) => {
      const [, r] = this.status(id, now);
      const st = r.state ?? {};
      const exp = typeof st.lease_expires_at === "number" ? st.lease_expires_at : 0;
      const status = ["CORRUPT", "UNKNOWN"].includes(r.status) ? r.status : r.status === "HELD" ? "CLAIMED" : st.state === "RELEASED" ? "RELEASED" : st.session_id ? "EXPIRED" : "FREE";
      return { id, status, holder: st.session_id ?? null, epoch: st.epoch ?? null, expires_in: Math.max(0, Math.trunc(exp - r.now)) };
    });
  }
}
