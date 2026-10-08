---
name: orch-swarm
description: Use when the lead wants to run one goal as parallel work across subagents or orch workers ("swarm this", "fan this out"), or on /orch-swarm. First decides whether parallel work helps at all. Then builds a task graph (one writer per file, explicit evidence per task), dispatches each task under the operator's configured policy, claims through `orch task`, accepts each task only on evidence, and closes with a DONE report. Loading it grants no new authority.
---

# /orch-swarm — one goal, many agents, one owner

A procedure, not a scheduler. The session that runs it stays the owner of the result.

## 0. What this does not grant

Merging, deploying, spending money, writing shared production data, force-pushing and
messaging people outside the team stay with whoever held them before. A task that
needs one of these stops with a `QUESTION` to that person. It does not continue
"pending approval".

## 1. Does parallel work help?

- Start from the outcome: what exists at the end, and who accepts it.
- If the problem is not understood yet, the first task is a read-only diagnosis. Do
  not fan out on an unclear goal.
- A serial bottleneck (one file everyone must touch, one shared database) does not
  get faster with more agents. Keep it serial.
- Do not create tasks for work already running elsewhere: check `orch task list`
  first.

## 2. Build the task graph

Each task has:

| Field | Meaning |
|---|---|
| `id` | short and unique, used for `orch task claim` |
| `goal` | one sentence: the outcome |
| `write_scope` | the exact file paths this task may write; no globs |
| `evidence` | the exact command and the predicate that must hold ("tests pass" is not enough) |
| `depends_on` | task ids that must be accepted first |

Constraints:
- **One writer per file.** Two tasks may not list the same path.
- A shared resource that is not a file (a test database, a queue, a staging service)
  is named and serialized like a file.
- Read-only tasks may run in parallel freely.
- Waves mean "this order, if the earlier wave is accepted", not "all runnable now".
  Re-check before each wave.
- Size the number of tasks in flight by what the machine sustains: `orch load` and
  the `[workers] block_tiers` setting refuse new workers at HIGH and CRITICAL.

## 3. Dispatch each task

Which agent or model takes which kind of task is the operator's decision: use the
operator's configured policy. This skill sets no routing of its own. Two rules hold
under any policy:

- Final acceptance stays with the session that runs this skill. It is not delegated.
- A review is done by a different agent than the author.

Before each dispatch, check: is a claim already open for this task, or is a worker
already on it? If so, do not dispatch again. Read the existing one.

## 4. Claim and execute

- `orch task claim <id>`. Exit 3 (`BUSY`) means someone else holds it: pick another
  task. Never take over a claim on your own judgment.
- One agent per task. The brief stands alone; a subagent does not see your history:

  ```
  GOAL: <one sentence>
  FILES YOU MAY WRITE: <exact paths>
  ALREADY RULED OUT: <what earlier tasks proved wrong>
  EVIDENCE: <exact command + predicate>
  LIMITS: <the tool-call and attempt limits the operator set, if any>
  DO NOT: push, merge, deploy, spend money, message anyone outside the team.
  REPORT: what you did, the verbatim output of the evidence command, what is
  UNVERIFIED, every file you wrote.
  ```

- For a long task, use a background worker with its own worktree:
  `orch worker start <id> --worktree --task brief.md`.
- Every background process a subagent starts, it stops before reporting.

## 5. Accept on evidence only

1. Run the evidence command yourself, or read its verbatim output. Prose without
   command output is not evidence.
2. For any correctness claim, ask: is there an input that makes this check fail?
   Record one failing case (for example, break the code on purpose and watch the test
   go red). If no such input exists, label the claim "structural, not measured".
3. Reviews count only when independent: a reviewer who read another reviewer's
   findings first is not independent.
4. Check what the change did not target. One number going up while another goes down
   is the common failure.

## 6. Close

Build the DONE report in a separate step, from printed output only:
`git log -1`, `git status --short`, the evidence command and its output, which agent
did what, and an UNVERIFIED list. Then
`orch msg send DONE --to lead -m "<report>"` and `orch task release <id> --expected-epoch <n>`.

## 7. When things fail

| Situation | Action |
|---|---|
| Missing permission (merge, spend, production, outward message) | `QUESTION` to whoever decides; stop the task |
| Missing instrument (no access, tool absent) | `BLOCKED` with the exact error text; never substitute a guess |
| A task keeps failing | stop and follow the operator's configured policy for retries and escalation; do not invent one. `/orch-advisor` is an optional diagnosis recipe |
| A result looks too good | treat it as a red flag; re-check what the metric measures |

Never report DONE when a step was skipped. Name the skip.
