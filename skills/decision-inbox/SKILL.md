---
name: decision-inbox
description: Use when asked to collect or prepare decisions waiting for a human, with evidence and a recommendation. Exclude executing a decision or providing ordinary status without a decision to make.
---

# Decision inbox

Find waiting decisions in the team's task source and relevant accessible records.
Use an available mail, calendar, CRM, or other connector when relevant; otherwise ask
for the needed input and mark missing evidence. Recheck each item's current status.

For each decision state what must be decided, the minimum facts with sources, the
consequence of no decision, and a crisp recommendation. Identify uncertainty and
when a decision is due if supported. Do not execute the decision until the human has
ruled; any subsequent action still requires its applicable authorization.

Queue each item durably in `$ORCH_HOME/decisions.md` (default `~/.orch/decisions.md`)
or the team's existing equivalent, with a stable identifier and status. Record the
human's ruling and its date alongside the item, preserving the decision and evidence
for later reference.
