---
name: caffeine
description: Use when the machine must stay awake while the team keeps working without the human ("I'm going to bed but keep it running", "I'll be out for hours, let it run", "turn caffeine off"), or /caffeine. Keeps the system awake (the screen may sleep) with a hard time cap, and optionally ends on an observable condition such as a PR merging or a task's DONE message. Not for a short absence (/away) and not for stopping the team (/sleep).
---

# /caffeine — the machine stays awake, the team keeps working

Three modes, kept distinct:
- `/away`: short absence, the human is back before anything sleeps.
- `/caffeine`: the human sleeps or leaves for long; the team keeps working.
- `/sleep`: the human sleeps and the team stops.

## Procedure

1. **Ask the mode question before running anything:** "Run until the cap, or stop
   when a specific thing is finished?"
   - until the cap → `forever`
   - until a thing → `until`. The thing must be **observable**: a PR merged, a
     `DONE` message for a named task, a file appearing. "When it is mostly done" is
     not observable; ask again.

2. **Set a cap that covers the whole absence.** Ask when the human expects to be back
   and add margin. A cap that expires at 5 a.m. lets the machine sleep, and every lease
   and claim held by a sleeping worker then expires with it. Default 8 hours only when
   the human names nothing.

3. **For `until`, check the condition can actually happen.** If the named task has an
   open `QUESTION` or `BLOCKED` message, its `DONE` may never come and the machine
   stays awake until the cap. Resolve the question first, or pick another condition.

4. **Start it** and record the pid in `$ORCH_HOME/caffeine.json`:

   ```sh
   CAP=$((8*3600))
   # macOS: keep the system awake, let the display sleep (never -d)
   caffeinate -ims -t "$CAP" & echo $! > "$ORCH_HOME/caffeine.pid"
   # Linux with systemd
   systemd-inhibit --what=sleep:idle --why="orch team running" sleep "$CAP" & echo $! > "$ORCH_HOME/caffeine.pid"
   ```

   For `until`, run a small watcher next to it that polls the condition and then
   kills the keep-awake pid (and, if the human asked for it, runs `/sleep`):

   ```sh
   until gh pr view 42 --json state -q .state | grep -qx MERGED; do sleep 300; done
   kill "$(cat "$ORCH_HOME/caffeine.pid")"
   ```

5. **Tell the team** which mode and cap are active:
   `orch mailbox post lead -m "Caffeine <mode>, cap <time>, stop condition <...>."`

6. **Verify and report five facts:** keep-awake process alive, system sleep
   prevented, display sleep allowed, watcher alive (for `until`), expiry time.
   - macOS: `pmset -g assertions` shows `PreventSystemSleep 1` and
     `PreventUserIdleDisplaySleep 0`.
   - Linux: `systemd-inhibit --list` shows the entry.

## Off

Kill the pid in `$ORCH_HOME/caffeine.pid` and the watcher, then check the assertion is
gone. Another program may hold a short keep-awake of its own. Name it; do not chase it.

## Limits

Keep-awake does not stop scheduled loops or workers; they keep running until `/sleep`.
If the machine is closed or loses power, the cap does not matter.
