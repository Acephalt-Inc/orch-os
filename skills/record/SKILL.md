---
name: record
description: Use whenever work needs a durable trace — after a decision, a finished research or diagnosis, an incident, a ticket update, or the end of a phase — or on /record. Enforces one standard. A record is done only when someone with zero context can find it, understand it and revive the work, and the completion check below passes.
---

# /record — the durable-trace standard

A record's reader is someone, often a future session of yourself, with **no
conversation context**. Judge every record by that reader, not by the person writing
it today. A method whose only record is one line in a notes file with no lineage and no
link back can be lost for weeks without anyone noticing.

## Five questions every record answers

1. **What.** The decision or finding, stated so it can be carried out or proven wrong.
2. **Why.** The evidence and the instrument that produced it: the command run, the
   lines read, and when. A claim without its instrument is not a record.
3. **Who decided, and when.** A name and an absolute date. "We decided" without a
   name turns rulings into folklore.
4. **Where the artifacts live.** Every sibling named: repo path, PR, ticket id, note
   name (`orch mem`), deployed copy. Records that do not cross-link die alone.
5. **How to revive or reverse it.** The exact re-entry point: a branch kept at a sha,
   a rollback one-liner, a reopen condition. If it cannot be reversed, say so.

## Placement

Decide once, per project, where each kind of record lives, and write the table into
the project's docs. A starting point:

| Content | Home |
|---|---|
| Engineering research, methods, design decisions | the repo, `docs/` (dated file names) |
| Team rules and protocol changes | the handbook (`protocols.md`), in a dated section, announced on the mailbox |
| Short facts the team should know next week | `orch mem add` |
| Secrets, credentials, confidential third-party material, personal data | never in a repo |

## Tickets are records too

A substantive ticket comment carries: the state change, the instrument behind each
claim, what would close the ticket, and links (PR, doc, runbook). Before changing a
ticket's state, **read the ticket** and confirm it is what its number claims. A PR
that carries the wrong ticket id can drag an unrelated ticket through several states.

## Lineage

Any rewrite of a standing doc, skill or config keeps a `Lineage:` line: what it
replaces, what changed, and what the change **removes** (a trigger, a section). Keep
the previous version next to it. Changing what a skill's `description` triggers on is
a change to the discipline itself; get the owner's agreement first.

## Findability

- Dated, kebab-case file names (`topic-YYYY-MM-DD.md`).
- A one-line entry in the relevant index (`orch mem`, `docs/INDEX.md`, the mailbox)
  in the same change.
- One grep-able marker string per record, stated in the record ("grep for X").

## When this must fire

- A ruling lands → a note plus the routed home.
- Research or a diagnosis completes → a doc, an index line, a ticket link if a
  ticket exists.
- An incident closes → the diagnosis, what caused it, and the records it corrected.
- A standing doc, skill or loop changes → a lineage line plus a backup.
- A phase ends or work is handed over → a snapshot of open threads.

## Completion check

☐ five questions answered ☐ placed in its home ☐ siblings cross-linked
☐ lineage kept if it replaced anything ☐ index line written ☐ instrument named

## Before a procedure becomes a shared skill

Keep a new procedure local (written into the task that uses it) until all four hold:

1. **Baseline.** One real task of the target kind was done without the skill.
2. **With the skill.** A second real task of the same kind was done with it. Real
   means it produced a PR, a deliverable or checkable output; rehearsals do not count.
3. **Replay by someone else.** An agent that did not write the skill replays a real
   task with and without it, with the same inputs, model settings and tools.
4. **Trap case.** One deliberately broken scenario the skill claims to catch fails
   without the skill and passes with it. A check that cannot fail is not a check.

Ship the skill with its scope, known failure modes, owner, rollback and what it
replaces.
