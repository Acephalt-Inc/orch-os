---
name: full-throttle
description: Use when the human wants the whole team running at capacity ("full speed", "keep every worker busy", "dispatch as much as possible"), or /full-throttle. The human states goals. The lead writes one short brief per line of work, and each worker splits its brief into tasks and pulls the next one the moment it frees up. Task count is limited by capacity and review throughput, never by a number the lead picked. The lead only talks to the human, writes briefs, answers questions and merges.
---

# /full-throttle — briefs, not task lists; pull, not push

When the lead writes every task, the lead's time caps the team. Forty tasks take a
long time to write; six briefs do not. So the lead writes **briefs** and the workers
**decompose and pull**.

## Roles while active

| Role | Does | Never |
|---|---|---|
| Lead | talks to the human, writes briefs, answers `QUESTION`s, merges (`/serial-merge`), reports | implements |
| Worker | splits its brief into tasks, claims and does them, pulls the next one | merges, deploys, writes production data |
| Reviewer | reviews PRs it did not author | reviews its own |

## Sequence

1. **Goals.** Restate each line of work as `goal · done when · owner` in a table. The
   human corrects it before anything is dispatched.

2. **Take stock.** Open to-dos, `orch task list`, `gh pr list --state open`, and
   unanswered `QUESTION`/`BLOCKED` messages (`orch msg read`). Record counts only.

3. **One brief per line.** Post it with `orch mailbox post <worker> -m "<brief>"`:
   - **goal**;
   - **done when**: visible to a user or checkable by a command, not "code written";
   - **boundaries**: files, flags and data it may and may not touch;
   - **evidence**: what proves each task;
   - **review rule**: who reviews its PRs;
   - **budget**: time, and money if any (default none).

   The worker splits the brief into tasks that are independent (disjoint files), one
   PR each, about two hours or less, and claims them with `orch task claim` before
   starting. The lead still writes tasks directly for hotfixes and anything with an
   outside deadline.

4. **Pull, not push.** A worker claims its next task the moment it frees up. When its
   own line is exhausted, it pulls from any brief marked `open-to-all`, then from the
   shared backlog. A worker idle for more than 15 minutes sends
   `orch msg send BLOCKED --to lead -m "STARVED"`, and the lead writes a new brief.
   Nobody waits for the lead to hand out the next task.

5. **Size by capacity.** Start workers while `orch load` is below the blocking tiers.
   At HIGH and CRITICAL, new workers are refused anyway; let the running ones finish.

6. **Review capacity is the real ceiling. Build it in.**
   - Every PR needs an independent reviewer. Pair them: worker A's PRs go to worker
     B, and B's go to A.
   - **Backpressure:** when more than 6 open PRs have no review, every worker switches
     one lane from writing to reviewing until the count is 3 or less. A review is
     cheaper than a PR that rots into conflicts.
   - Work-in-progress limit: no worker has more than 6 open PRs of its own. Beyond
     that it reviews or rebases.

7. **Merge continuously.** The lead merges each PR once `orch merge-gate` passes, one
   at a time with a re-check (`/serial-merge`), rather than holding ready PRs.

8. **Report.** First a board: lines × owner × tasks queued. After that, deltas only
   (`DONE`, `BLOCKED`, `QUESTION`), bad news first.

## Why this beats "the lead writes N tasks"

| Lead writes tasks | Briefs plus pull |
|---|---|
| the lead's time caps the task count | task count scales with the workers |
| queued tasks go stale | workers split just in time, against the current main branch |
| the lead sees every detail | the lead sees goals, gates and evidence |
| an empty queue means idle workers | `STARVED` plus backlog pull means nobody idles |

## Hard rails (unchanged by this mode)

The merge gate, deploy rules, no writes to shared production data, no outward messages
without the usual checks, and no spending beyond what was approved. Unsure about scope,
authority or budget: stop and ask.

## Off

The human says stop → `/sleep`.
