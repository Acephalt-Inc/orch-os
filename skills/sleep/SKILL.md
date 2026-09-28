---
name: sleep
description: Use when the human says the whole team should stop for the night ("going to sleep, stop everything", "we're done for today") or invokes /sleep. Persists work state to disk, tells every worker to stop at a safe point, stops workers and scheduled polling, and writes a snapshot that the next morning's boot restores from. Not for leaving while work continues (/away, /caffeine).
---

# /sleep — persist, announce, stop, verify

The morning restart must come from a written snapshot, never from what a session
remembers. A restart from recollection silently drops the one loop nobody wrote down.

**Order matters: persist and announce before you stop anything.** A worker that is
stopped before it hears "stop at a safe point" can die mid-commit.

## Steps

1. **List what is running**, and keep the output. It becomes the snapshot.
   - `orch worker list`
   - `orch task list`
   - scheduled loops in your agent sessions (for example `/loop` jobs or session
     cron entries): copy their ids and schedules verbatim
   - OS-level jobs you started for the team (cron lines, timers, a keep-awake process)

2. **Persist work state.**
   - Open items, one line each, into your team's to-do file.
   - A session note: `orch mem add session-<date> -d "state at sleep" -m "<open threads, in-flight PRs, next steps>"`.
   - Any half-written diagnosis or report goes into its own file, not the chat.

3. **Tell the workers first** (a broadcast nobody has to answer, so the mailbox):
   `orch mailbox post lead -m "Team sleep at <time>: finish or park at the next safe point (never mid-commit), claim nothing new, leave open questions open. Resume only after the morning boot."`
   Give them a few minutes. A worker that cannot park cleanly says so with
   `orch msg send BLOCKED --to lead`; check `orch msg read` before stopping anyone.

4. **Stop polling and workers.**
   - Stop the scheduled session loops from step 1.
   - `orch worker stop <name>` for each worker. A worktree with uncommitted changes is
     kept; note which ones.
   - Stop any keep-awake process (`/caffeine off`).

5. **Write the snapshot** to `$ORCH_HOME/sleep.json`: the time, the lead lease epoch
   (`orch lease status --json`), and every item from step 1 with how it was stopped.
   Then release the lead lease if a different session will boot in the morning:
   `orch lease release --expected-epoch <epoch>`.

6. **Verify before saying "stopped".** Report stopped only if all of these hold:
   - `orch worker list` shows no running worker;
   - no scheduled session loop is left (list them again);
   - no keep-awake process (`pgrep -fl caffeinate` / `systemd-inhibit --list`);
   - `$ORCH_HOME/sleep.json` exists with today's timestamp and a non-empty job list.

7. **Report in one table:** snapshot time, workers stopped, loops stopped, worktrees
   kept dirty, lease released or kept. Then stop.

## Morning

Boot the lead (`/orch-lead-boot`), read `$ORCH_HOME/sleep.json`, and restart exactly the
jobs it lists. Compare the list with what is now running and report any difference.
