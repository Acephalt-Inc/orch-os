# Lead boot, dispatch and tick

Boot and tick inspect local coordination state and save receipts. Dispatch launches one explicitly approved task. These commands do not run a background service. Scheduler, assistant wake and memory integration report `UNAVAILABLE`.

```sh
orch lead boot --session session-a --seconds 120
orch lead tick --session session-a --expected-epoch 1 --tick 1 --approved --seconds 120
orch lead dispatch --session session-a --expected-epoch 1 --approved --task-file task.json
```

Use a unique session name and the epoch returned by boot. Boot acquires the configured role lease or renews it for the same session. Another unexpired holder returns exit 3. Tick renews only the existing holder with its expected epoch; a wrong holder, stale epoch or expired lease returns exit 4. These commands never force takeover. Without an external caller, renewal stops when the command exits and the lease eventually expires.

`--approved` authorizes one invocation of the fixed event-inspection tick. It does not enable recurring work. Tick numbers must be positive safe integers that increase across sessions and lease epochs. Retry a delivery with the same number. A number at or below the last saved number returns `DUPLICATE` without inspecting events again.

A tick inspects up to 100 new messages addressed to `lead`, including broadcasts from other senders. It returns `PROCESSED` with event metadata, or `IDLE` when there are no new events. Bodies are not executed or copied into receipts. Inspection does not acknowledge messages: use the existing message commands to answer and acknowledge them. A plain DONE message alone does not prove worker completion. A verified invocation includes a `completion` object bound to its generated DONE event.

Dispatch requires a fresh, explicit `--approved` on every invocation. The task file is JSON with `id`, `brief`, `command` (nonempty argv string array), `workdir` (an existing directory), and `timeout_seconds` (integer 1–86400). Dispatch requires prior boot and the current lease holder and epoch. It checks for `timeout` or `gtimeout` with `--kill-after` support before reserving anything; the probe requires a KILL exit from the timeout wrapper around a TERM-resistant child, so it does not rely on GNU version text. The probe child also has its own four-second exit. POSIX process control, the load governor and the configured profile worker limit apply. On Windows, dispatch reports `UNAVAILABLE` with a reason because a process-control adapter is not available. A missing or incompatible timeout program also reports `UNAVAILABLE` and launches nothing. An existing reservation remains `BLOCKED` even if timeout support is later unavailable.

One task slot is reserved before claiming the task and launching a detached supervisor. The slot remains occupied after success or failure, so another approved task needs a later slice. A crash at any point after reservation also blocks retry: absence of a PID or exit file is not evidence that no task ran. Immediately before launching, the supervisor rechecks the role lease and task claim under their locks, writes an invocation-bound launch gate, then runs the exact argv with task brief on stdin under `timeout --kill-after=1s`. It releases the locks once the timeout process starts, without waiting for the task under them. It records the timeout wrapper's OS exit code or signal. Exit code 124 or 137 can indicate timeout, but may also be returned by the task; the receipt reports observed exit evidence without asserting its cause. The supervisor itself has no Workers timeout. Do not delete the reservation or gate to retry.

On a new approved tick, the lead validates gate and exit identity against the reservation, publishes a stable completion event under the message lock, consumes it through the normal cursor, and releases only its matching task claim epoch. Replaying after a crash between publication and cursor commit reuses the same message ID. Corrupt or mismatched evidence blocks reconciliation. A duplicate tick does not inspect or publish completion. Boot reports the occupied slot without consuming events. Scheduler, wake and memory remain `UNAVAILABLE`.

The state file is the configured lease path plus `.lead.json`. It contains version 1, the resolved message path, `event_cursor`, `last_tick`, `boot_count` and the latest committed `receipt`. Boot preserves the cursor and last tick, increments the boot count and reports the previous receipt's session. This is loop-position recovery; current-task and accepted-memory recovery are unavailable.

Boot, dispatch and tick calls sharing a lease serialize through its `.lead.lock.d` lock. They verify ownership under the existing lease lock before launching or atomically saving the cursor and receipt together, with file fsync and mode 0600. A crash before receipt replacement leaves the old cursor; a crash after it leaves the saved receipt even if output was lost. Dispatch is a single-use reservation, not a general scheduler.

Invalid usage, unavailable files, corrupt state, a changed message path or a log rewound below the cursor return exit 2. Preserve the files and reconcile their history before continuing; deleting the cursor can replay events. Log rotation is not supported by this loop yet. File fsync does not guarantee directory-entry survival after power loss. Although each receipt has at most 100 events, the existing message reader loads the whole log.

Output is JSON. `READY` means boot completed, not that scheduling or assistant activation was verified. Existing `lead install`, `lead status` and `lead uninstall` still manage the instruction pack separately.
