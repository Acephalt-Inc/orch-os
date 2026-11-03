# Lead boot and tick

These commands inspect local coordination state and save receipts. They do not run a background service. Scheduler, assistant wake and memory integration report `UNAVAILABLE`.

```sh
orch lead boot --session session-a --seconds 120
orch lead tick --session session-a --expected-epoch 1 --tick 1 --approved --seconds 120
```

Use a unique session name and the epoch returned by boot. Boot acquires the configured role lease or renews it for the same session. Another unexpired holder returns exit 3. Tick renews only the existing holder with its expected epoch; a wrong holder, stale epoch or expired lease returns exit 4. These commands never force takeover. Without an external caller, renewal stops when the command exits and the lease eventually expires.

`--approved` authorizes one invocation of the fixed event-inspection tick. It does not enable recurring work. Tick numbers must be positive safe integers that increase across sessions and lease epochs. Retry a delivery with the same number. A number at or below the last saved number returns `DUPLICATE` without inspecting events again.

A tick inspects up to 100 new messages addressed to `lead`, including broadcasts from other senders. It returns `PROCESSED` with event metadata, or `IDLE` when there are no new events. Bodies are not executed or copied into receipts. Inspection does not acknowledge messages: use the existing message commands to answer and acknowledge them. A DONE message alone does not prove worker completion. Every receipt reports a BLOCKED dispatch decision and reason because this slice launches no workers.

The state file is the configured lease path plus `.lead.json`. It contains version 1, the resolved message path, `event_cursor`, `last_tick`, `boot_count` and the latest committed `receipt`. Boot preserves the cursor and last tick, increments the boot count and reports the previous receipt's session. This is loop-position recovery; current-task and accepted-memory recovery are unavailable.

Boot/tick calls sharing a lease serialize through its `.lead.lock.d` lock. They verify ownership under the existing lease lock before atomically saving the cursor and receipt together, with file fsync and mode 0600. A crash before this replacement leaves the old cursor; a crash after it leaves the saved receipt even if output was lost. This is local state deduplication, not exactly-once external execution or fencing of unrelated programs.

Invalid usage, unavailable files, corrupt state, a changed message path or a log rewound below the cursor return exit 2. Preserve the files and reconcile their history before continuing; deleting the cursor can replay events. Log rotation is not supported by this loop yet. File fsync does not guarantee directory-entry survival after power loss. Although each receipt has at most 100 events, the existing message reader loads the whole log.

Output is JSON. `READY` means boot completed, not that scheduling or assistant activation was verified. Existing `lead install`, `lead status` and `lead uninstall` still manage the instruction pack separately.
