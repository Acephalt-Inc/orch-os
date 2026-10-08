---
name: night-shift
description: Use when the team should keep working overnight but only on work that is reversible and costs nothing ("night shift", "only safe work tonight"), or /night-shift. Sorts queued tasks into ALLOW and DENY, failing closed, and freezes merges, deploys, production data, configuration switches, spending, outward messages and force-pushes until the morning report. Usually runs together with /caffeine. Not /sleep (the team stops).
---

# /night-shift — only reversible, zero-cost work while nobody watches

> Optional recipe. A person chooses to use it; it is not a product mode and nothing installs or schedules it. It grants no authority: every time, limit and permission in it is a value the operator sets.

Nobody is awake to catch a mistake, so the night allows only work whose worst outcome
is a discarded branch.

## Enter

1. **Sort the queue.** For every queued task, decide ALLOW or DENY from what the task
   will actually do and under whose authority, and write the table down. The wording
   of the task does not decide it:

   | DENY if the task would | ALLOW only if every action in it is |
   |---|---|
   | merge, deploy, touch production, write a database, change a feature flag or configuration, spend money or start a paid run, send / post / publish / email, force-push, delete, or use a credential or key | review, research, documentation, tests, a draft PR that nobody merges, read-only diagnosis |

   A task that is not clearly ALLOW is DENY: **fail closed**. A DENY task stays denied
   until the person who holds that authority allows it. Rewording a denied task does
   not make it allowed; if only part of it is safe, the human splits it into a new
   task in the morning. Never widen the rules for one task.

2. **Write the marker** `$ORCH_HOME/night.json`: start time, the ALLOW list, the DENY
   list, and the frozen actions. The morning report is a delta against it.

3. **Pre-answer the likely questions.** For each ALLOW task, add one line: "if X
   comes up, do Y". Workers that hit an unanswered question park the task and switch
   to the next one; they do not wait.

4. **Announce it** on the mailbox (a broadcast nobody has to answer):
   `orch mailbox post lead -m "Night shift on. Allowed: <ids>. Frozen: merges, deploys, prod data, config switches, spending, outward messages, force-push. Question you cannot answer from the pre-answers → park and switch."`

5. Confirm the machine will stay awake long enough (`/caffeine`).

## During the night (lead)

- No merges, even for PRs that pass `orch merge-gate`. List them for the morning.
- No deploys, no production data, no configuration switches, no spending, no outward
  messages.
- Answer a worker's `QUESTION` only when the answer is already written down (the
  pre-answers or a standing rule). Otherwise leave it for the morning.
- Wake the human only for: production down, runaway spending, the whole team dead.

## Exit (morning, or the human's first message)

1. Report first, bad news first: what finished (with evidence), what parked and why,
   questions waiting, and a table of PRs that now pass `orch merge-gate` (PR, what it
   changes, next step).
2. Archive the marker: `mv "$ORCH_HOME/night.json" "$ORCH_HOME/night.last.json"`.
3. `orch mailbox post lead -m "Night shift off; normal routing resumed."`

## Signs the shift is set up wrong (put them in the report)

- Any frozen action happened.
- A question blocked a worker without a task switch for longer than the operator
  accepts.
- The morning report took the human longer than they accept, or a night result was
  sent back for rework.
