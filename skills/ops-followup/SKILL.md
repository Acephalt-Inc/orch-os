---
name: ops-followup
description: Use when asked to track operational commitments and prepare follow-ups for overdue or upcoming obligations. Exclude sending messages without explicit approval or creating a general project progress report.
---

# Operations follow-up

Consult the team's task source and relevant available mail, calendar, or CRM
connectors. If a needed source is unavailable, ask for the relevant input and mark
the gap. For each commitment report who owes what, its due date, evidence, and the
next appropriate nudge; label unknown owners or dates rather than guessing.

Assign each follow-up a stable ID. Check existing work with `orch task list --json`
and `orch mem search ops-`; use `orch task status <id> --json` for a specific claim.
For user-requested local tracking, coordinate with `orch task claim <id> --json` and
record the epoch, then create a paired durable note:

`orch mem add ops-<id>-<revision> --description "<who owes what>" -m "<due date, next nudge, sources, status>"`

The claim holder is the coordinating agent, not necessarily the person who owes the
commitment. ORCH claims track holders, epochs, and expiry; due dates and follow-up
details belong in the note or the team's task source. When releasing a claim, use
`orch task release <id> --expected-epoch <epoch>`. Resume by reading the claims and searching notes for the stable task ID and latest
revision. When facts change, add a new note with the same task ID and a unique revision,
then retire the previous note with
`orch mem retire ops-<id>-<old-revision> --superseded-by ops-<id>-<new-revision>`.
Keep using the stable task ID for claims.
Draft follow-up messages for review; never send one without explicit approval.
