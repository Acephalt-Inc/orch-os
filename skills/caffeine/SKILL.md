---
name: caffeine
description: Use when asked to keep a machine awake for bounded unattended work or turn that keep-awake off. Exclude ordinary absences and requests to stop the team.
---

# /caffeine — the machine stays awake, the team keeps working

> Optional recipe. A person chooses to use it; it is not a product mode and nothing installs or schedules it. It grants no authority: every time, limit and permission in it is a value the operator sets.

Three recipes, kept distinct:
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
   and claim held by a sleeping worker then expires with it. There is no default: if
   the human names no cap, ask again.

3. **For `until`, check the condition can actually happen.** If the named task has an
   open `QUESTION` or `BLOCKED` message, its `DONE` may never come and the machine
   stays awake until the cap. Resolve the question first, or pick another condition.

4. **Start a supported keep-awake helper** with the approved cap. On macOS,
   `caffeinate -ims -t <seconds>` keeps the system awake while allowing display sleep.
   On Linux, use `systemd-inhibit` if available. On Windows, report `UNAVAILABLE`
   with the reason unless a supported keep-awake method is actually available and
   verified. Do not report success without verification.

   Record the task-owned helper's PID, start time, command identity, cap, and any
   watcher identity in `$ORCH_HOME/caffeine.json`. For `until`, use a watcher only
   with an authorized cadence and stop condition; it must recheck ownership before
   stopping the helper. If ownership cannot be verified, leave it running and report
   the limitation.

5. **Tell the team** which mode and cap are active:
   `orch mailbox post lead -m "Caffeine <mode>, cap <time>, stop condition <...>."`

6. **Verify and report five facts:** keep-awake process alive, system sleep
   prevented, display sleep allowed, watcher alive (for `until`), expiry time.
   - macOS: `pmset -g assertions` shows `PreventSystemSleep 1` and
     `PreventUserIdleDisplaySleep 0`.
   - Linux: `systemd-inhibit --list` shows the entry.

## Off

Recheck the recorded PID, start time, and command identity immediately before
stopping each task-owned helper or watcher. Stop only a verified match, then verify
exit and check the assertion. If identity cannot be established, preserve the process
and report the limitation. Leave other programs alone.

## Limits

Keep-awake does not stop scheduled loops or workers; they keep running until `/sleep`.
If the machine is closed or loses power, the cap does not matter.
