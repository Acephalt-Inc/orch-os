// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Detached, single-use supervisor for one approved task. */
import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { Lease } from "../lease.js";
import { withLock } from "../lock.js";
import { Tasks } from "../tasks.js";
import { atomicWrite } from "../util.js";

const path = process.argv[2] ? Buffer.from(process.argv[2], "base64url").toString("utf8") : "", nonce = process.argv[3];
if (!path || !nonce) process.exit(2);
try {
  const task = JSON.parse(readFileSync(path, "utf8"));
  if (task.nonce !== nonce || task.phase !== "CLAIMED" || !Number.isSafeInteger(task.claim_epoch) || task.claim_epoch < 1) process.exit(2);
  const evidence = { id: task.id, nonce, task: task.task.id, pid: process.pid, process_group: "inherited" };
  const child = withLock(task.lease_path + ".lead.lock.d", () => withLock(task.lease_path + ".lock.d", () => {
    const role = new Lease(task.lease_path).load();
    const [code, claim] = new Tasks(task.task_dir).status(task.task.id);
    if (role.session_id !== task.lead_session || role.epoch !== task.lead_epoch || role.state !== "ACTIVE"
      || role.lease_expires_at <= Date.now() / 1000 || code !== 0 || claim.status !== "HELD"
      || claim.state.session_id !== task.holder || claim.state.epoch !== task.claim_epoch) throw new Error("launch fence changed");
    const gate = openSync(path + ".gate", "wx", 0o600);
    try { writeSync(gate, JSON.stringify(evidence) + "\n"); fsyncSync(gate); } finally { closeSync(gate); }
    return spawn(task.timeout_bin, ["--foreground", "--kill-after=1s", `${task.task.timeout_seconds}s`, ...task.task.command], {
      cwd: task.task.workdir, stdio: ["pipe", "inherit", "inherit"],
    });
  }, { protectLive: true }), { protectLive: true });
  let error: string | null = null;
  child.on("error", (e) => { error = e.message; });
  child.on("close", (exit_code, signal) => {
    atomicWrite(path + ".exit", JSON.stringify({ ...evidence, exit_code, signal, error }) + "\n", { fsync: true, mode: 0o600 });
  });
  // A task may exit without reading its brief; retain its observed exit evidence.
  child.stdin?.on("error", () => {});
  child.stdin?.end(task.task.brief);
} catch (e) {
  // Reservation and gate remain as a blocker if launch or evidence is uncertain.
  process.stderr.write(`lead supervisor: ${e instanceof Error ? e.message : "unavailable"}\n`);
  process.exitCode = 2;
}
