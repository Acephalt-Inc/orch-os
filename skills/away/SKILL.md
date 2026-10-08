---
name: away
description: Use when the human says they are leaving and the team should keep working without them ("I'm heading out, keep going", "report when I'm back", "you drive for a while"), or invokes /away. Writes a snapshot to diff against later, sets the unattended rules (questions are queued, not asked; no interim status messages; nothing irreversible the human has not already approved), and owes one consolidated report when the human explicitly returns (/back). Not for stopping everything at the end of the day (/sleep) and not for a short pause in the conversation.
---

# /away — the human leaves, the team keeps working

> Optional recipe. A person chooses to use it; it is not a product mode and nothing installs or schedules it. It grants no authority: every time, limit and permission in it is a value the operator sets.

Two halves: **depart** now, and a **report debt** that stays open until the human
explicitly comes back. The report is a delta, and a delta needs a fixed left edge, so
the first thing this skill does is write that edge down.

## On invocation

1. **Write the snapshot** to `$ORCH_HOME/away.json` (default `~/.orch/away.json`):

   ```sh
   ORCH_HOME="${ORCH_HOME:-$HOME/.orch}"
   python3 - "$ORCH_HOME" <<'EOF'
   import json, subprocess, sys, time
   home = sys.argv[1]
   def run(*cmd):
       r = subprocess.run(cmd, capture_output=True, text=True)
       return r.stdout if r.returncode == 0 else None
   prs = run("gh", "pr", "list", "--state", "open", "--limit", "200",
             "--json", "number,title,headRefOid")
   tasks = run("orch", "task", "list", "--json")
   snap = {
       "away_at": time.time(),
       "away_at_human": time.strftime("%Y-%m-%d %H:%M %Z"),
       "open_prs": json.loads(prs) if prs else "UNAVAILABLE",
       "tasks": json.loads(tasks) if tasks else "UNAVAILABLE",
       "merges": "hold",          # or "continue" if the human said so before leaving
       "spend_cap": 0,            # money the human pre-approved for this absence
   }
   json.dump(snap, open(f"{home}/away.json", "w"), indent=1)
   print("snapshot written", snap["away_at_human"])
   EOF
   ```

   Record an unavailable source as `UNAVAILABLE`. Never fill it from recollection.

2. **Ask two questions before the human is gone**, and write both answers into the
   snapshot:
   - Do merges continue while you are away (`merges: continue`), or hold?
   - Is there any money I may spend while you are away (`spend_cap`)? Default 0.

3. **Confirm the posture in one short table.** The human is walking out the door:
   send a table, not paragraphs.

   | Item | While you are away |
   |---|---|
   | Work | continues; each worker keeps one claimed task |
   | Merges | `continue` (one at a time, gate passes) or `hold`, as you said |
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
