---
name: away
description: Use when a person leaves and explicitly wants work to continue unattended; snapshot the starting state and queue decisions for their return. Exclude stopping work or a brief conversational pause.
---

# /away — the human leaves, the team keeps working

> Optional recipe. A person chooses to use it; it is not a product mode and nothing installs or schedules it. It grants no authority: every time, limit and permission in it is a value the operator sets.

Two halves: **depart** now, and a **report debt** that stays open until the human
explicitly comes back. The report is a delta, and a delta needs a fixed left edge, so
the first thing this skill does is write that edge down.

## On invocation

1. **Write the snapshot** to `$ORCH_HOME/away.json` (default `~/.orch/away.json`),
   creating its parent directory if needed. Capture `away_at` (an absolute timestamp),
   `open_prs` from `gh pr list --state open --limit 200 --json number,title,headRefOid`,
   and `task_claims` from `orch task list --json`. Record unavailable sources as
   `UNAVAILABLE`, never from recollection. Record `merges` as `hold` and `spend_cap`
   as 0 unless the human has already specified otherwise.

2. **Confirm any specified limits.** Merges are performed by a human; if a human
   will merge while away, record that arrangement, otherwise hold. Record any
   explicitly approved spending cap; leave it at 0 if none was provided.

3. **Confirm the posture in one short table.** The human is walking out the door:
   send a table, not paragraphs.

   | Item | While you are away |
   |---|---|
   | Work | continues; each worker keeps one claimed task |
   | Merges | human performs each merge after the gate passes, or `hold` |
   | Money | up to `spend_cap`; beyond it, queued as a question |
   | Decisions for you | queued in `$ORCH_HOME/decisions.md`, not asked |
   | Reports | none until you say you are back |

4. **Tell the team.** `orch mailbox post lead -m "Human away since <time>. Route
   decisions to the lead; the lead queues what needs the human."` so no worker waits
   on someone who cannot answer.

## Rules while away

- **Questions queue, work continues.** Anything only the human can decide goes to
  `$ORCH_HOME/decisions.md` with a line saying *what happens if nobody decides*. A
  decision item without that line is a postponement, not a decision. Then take the
  next unblocked task; never sit idle waiting for the human.
- **Away is not a grant.** Deploys, production data, force-pushes, messages to people
  outside the team and anything irreversible follow exactly the rules that apply when
  the human is present. If they needed the human's word before, they still do.
- **No interim reports.** Log merges, finished tasks and incidents for the return
  report. Two exceptions: answer a direct question from the human briefly, or send one
  short line for a real incident that needs them now.

## What counts as a return

Only an explicit one: `/back`, or "I'm back". A plain message while away is often a
quick question from a phone. Answer it, keep the snapshot and the posture, and do not
produce the report. If the human asks for the report but stays away, give it and keep
the posture.

On return, run `/back`: it builds the delta against this snapshot.

## Not this skill

- The human is going to sleep and everything should stop: `/sleep`.
- The human is leaving for long and the machine must stay awake: `/caffeine`, usually
  together with this skill.
