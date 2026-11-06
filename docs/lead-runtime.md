# Lead boot, dispatch and tick

Boot and tick inspect local coordination state and save receipts. Dispatch launches one explicitly approved task. These commands do not run a background service. Their scheduler, assistant wake and memory integration fields report `UNAVAILABLE`.

## Start a lead in Claude Code

Install the lead pack in a new workspace, open it in Claude Code, and ask it to
lead a named piece of work. Agree on the scope, budget, check interval and when
to stop. For example: “Lead the approved tasks in this workspace. Check every
five minutes until those tasks are finished or I say stop. Queue decisions for
me while I am away.” This authorizes that run; installing files alone does not.

The installed skill points to its `boot.md` guide. The lead first runs boot to
take the lead role and save its place. It then uses Claude Code's own tools to
set up two ways to return to work: a watcher for new local events and a timer
as a safety check. Neither requires another prompt from you while the host is
running and the registrations remain active.

The watcher uses Monitor on the local wake event log, or the message watcher if
that log is missing. The timer uses a session-local scheduled task or `/loop`
with an explicit sentinel prompt. Claude Code documents these tools in its
[tools reference](https://code.claude.com/docs/en/tools-reference) and
[scheduling guide](https://code.claude.com/docs/en/scheduled-tasks).

The lead lists what was actually armed: watch handle, scheduled task ID, stable
key, interval, next run and expiry where available. Re-boot reuses the same
workspace/session key so it can reuse or replace its own registration. It must
check the host's records before creating another one, and re-arm an expired
registration while the approved run is active. If the host is closed, it checks
again when you resume; it cannot wake a closed session by itself.

For a timer with no visible expiry, the lead records its creation time and the
documented lifetime for that host version, then renews before that deadline.
If it cannot establish the lifetime, it reports expiry recovery as unverified.

`ARMED` means the host registration was read back. `UNVERIFIED` means that check
or event delivery has not been observed. `UNAVAILABLE` means the host cannot
provide that capability, with a reason. A successful boot or install is not
evidence that Claude Code will wake. The CLI's unavailable scheduler/wake fields
remain separate from this host evidence. Tool access can differ between CLI and
VS Code sessions, so the lead checks the tools in the session you actually use.

## What happens on each wake

The lead makes one short pass, saves its place, and yields. It answers workers'
open questions within the approved brief, queues decisions that need you,
checks finished work against artifacts and test evidence, then checks for stale
or blocked work. It considers the next approved task only when capacity allows.
Each pass handles at most 100 events and attempts at most one dispatch; more
work waits for another wake. Watcher and timer hints are combined so they do
not launch overlapping passes. Quiet checks do not need a status message.

The current dispatch runtime reserves one task until its verified completion
event has been consumed and the event cursor and receipt are committed. It
releases only the matching task claim after the supervisor's process group is
gone and the invocation-bound launch and exit evidence is valid. A live group,
unconsumed completion, or missing or corrupt evidence keeps the slot blocked.
The receipt reports the completion and whether a separate approved dispatch
can use the released slot; each next task needs its own approval.

If you say you are leaving, the lead continues independent work already
approved and saves decisions for you. On an explicit return, it gives one delta:
checked results, blocks, decisions needed and the next approved action. Being
away adds no permission to spend, merge, publish or contact people. A pause or
stop cancels only this run's watcher and timer and checks that they ended.

These are assistant instructions, not proof of an unattended run. Automated
tests check installed files and command names; live host wake delivery and
expiry recovery still need verification in your Claude Code session. The pack
installs the same boot guide for both hosts, but Codex must report Claude-only
tools unavailable. On Windows, the instruction pack and message commands can
be used, while wave-1 worker process control remains unavailable. The watcher
instructions use Node home/path handling rather than Unix shell expansion.

## Runtime commands and receipts

```sh
orch lead boot --session session-a --seconds 120
orch lead tick --session session-a --expected-epoch 1 --tick 1 --approved --seconds 120
orch lead dispatch --session session-a --expected-epoch 1 --approved --task-file task.json
```

Use a unique session name and the epoch returned by boot. Boot acquires the configured role lease or renews it for the same session. Another unexpired holder returns exit 3. Tick renews only the existing holder with its expected epoch; a wrong holder, stale epoch or expired lease returns exit 4. These commands never force takeover. Without an external caller, renewal stops when the command exits and the lease eventually expires.

`--approved` authorizes one invocation of the fixed event-inspection tick. It does not enable recurring work. Tick numbers must be positive safe integers that increase across sessions and lease epochs. Retry a delivery with the same number. A number at or below the last saved number returns `DUPLICATE` without inspecting events again.

A tick inspects up to 100 new messages addressed to `lead`, including broadcasts from other senders. It returns `PROCESSED` with event metadata, or `IDLE` when there are no new events. Bodies are not executed or copied into receipts. Inspection does not acknowledge messages: use the existing message commands to answer and acknowledge them. A plain DONE message alone does not prove worker completion. A verified invocation includes a `completion` object bound to its generated DONE event.

Dispatch requires a fresh, explicit `--approved` on every invocation. The task file is JSON with `id`, `brief`, `command` (nonempty argv string array), `workdir` (an existing directory), and `timeout_seconds` (integer 1–86400). Dispatch requires prior boot and the current lease holder and epoch. It checks for `timeout` or `gtimeout` with `--foreground` and `--kill-after` support before reserving anything; the probe requires a KILL exit from the timeout wrapper around a TERM-resistant child, so it does not rely on GNU version text. The probe child also has its own four-second exit. POSIX process control, the load governor and the configured profile worker limit apply. On Windows, dispatch reports `UNAVAILABLE` with a reason because a process-control adapter is not available. A missing or incompatible timeout program also reports `UNAVAILABLE` and launches nothing. An existing reservation remains `BLOCKED` even if timeout support is later unavailable.

One task slot is reserved before claiming the task and launching a detached supervisor. A crash before a verified completion leaves the slot occupied; absence of a PID or exit file is not evidence that no task ran. Immediately before launching, the supervisor rechecks the role lease and task claim under their locks, writes an invocation-bound launch gate with its inherited process-group mode, then runs the exact argv with task brief on stdin under `timeout --foreground --kill-after=1s`. It releases the locks once the timeout process starts, without waiting for the task under them. The supported command contract is a foreground task whose ordinary descendants retain the inherited process group. Commands that daemonize or call `setsid` or `setpgid` are unsupported: escaped descendants may outlive the task and are not included in the automatic release check. The supervisor records the timeout wrapper's OS exit code or signal. Exit code 124 or 137 can indicate timeout, but may also be returned by the task; the receipt reports observed exit evidence without asserting its cause. The supervisor itself has no Workers timeout. Do not delete the reservation or gate to retry.

On a new approved tick, the lead validates gate and exit identity against the reservation and publishes a stable completion event under the message lock. It commits the event cursor and receipt first. Then, once the supervisor's process group is gone, it releases only the matching task claim epoch and writes a `RELEASED` reservation with the verified completion, message sequence, inherited-group mode and process group ID. A later approved dispatch verifies this proof and removes the old gate and exit files before writing a new reservation. Task A can therefore complete and task B can launch in the same session, each with a separate approval. Replaying after a crash between publication and cursor commit reuses the same message ID; an approved increasing tick or dispatch recovers a crash between the cursor commit and the claim release or release marker. A duplicate tick can finish that release recovery without consuming or publishing again. A task descendant still running in the group keeps the slot blocked. After it stops, use the next approved increasing tick and retry with a separate approved dispatch. Dispatch returns `BLOCKED` with reconciliation guidance for corrupt or mismatched reservation evidence; tick keeps its error response for corrupt evidence. Corrupt, missing or legacy launch evidence also blocks automatic release: preserve the reservation and sidecars and recover the original invocation-bound evidence for manual review. PID absence, claim expiry and file deletion do not replace proof; there is no force bypass. Boot reports the slot without consuming events. Scheduler, wake and memory remain `UNAVAILABLE`.

The state file is the configured lease path plus `.lead.json`. It contains version 1, the resolved message path, `event_cursor`, `last_tick`, `boot_count` and the latest committed `receipt`. Boot preserves the cursor and last tick, increments the boot count and reports the previous receipt's session. This is loop-position recovery; current-task and accepted-memory recovery are unavailable.

Boot, dispatch and tick calls sharing a lease serialize through its `.lead.lock.d` lock. They verify ownership under the existing lease lock before launching or atomically saving the cursor and receipt together, with file fsync and mode 0600. A crash before receipt replacement leaves the old cursor; a crash after it leaves the saved receipt even if output was lost. Each dispatch approval reserves one invocation; verified completion frees the slot for a separately approved task. This is not a general scheduler.

Invalid usage, unavailable files, corrupt state, a changed message path or a log rewound below the cursor return exit 2. Preserve the files and reconcile their history before continuing; deleting the cursor can replay events. Log rotation is not supported by this loop yet. File fsync does not guarantee directory-entry survival after power loss. Although each receipt has at most 100 events, the existing message reader loads the whole log.

Output is JSON. `READY` means boot completed, not that scheduling or assistant activation was verified. Existing `lead install`, `lead status` and `lead uninstall` still manage the instruction pack separately.
