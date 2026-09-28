---
name: worker-boot
description: Start this session as a WORKER - check you are not the lead, catch up, claim one task, work it in your own worktree, and report DONE with evidence. Run it at the start of every session that executes tasks.
---

# Worker boot

A worker takes one task at a time from the lead, does it, and proves it is done. It never
decides scope, never merges, and never approves its own change. Run the steps in order.

## 0. Name yourself and check your role

```sh
export ORCH_AGENT=w1              # your worker name; each worker has its own
orch lease status                 # if the holder is you, you are in the wrong boot file
```

## 1. Catch up (read only)

```sh
cat "${ORCH_HOME:-$HOME/.orch}/mem/INDEX.md"   # standing rules and lessons
orch msg read                                  # answers and instructions addressed to you
orch task list                                 # anything you still hold?
git worktree list                              # your unfinished work on disk
```

A task you still hold from an earlier session is your first job: resume it, or release it
and tell the lead why.

## 2. Claim before you work

```sh
orch task claim <task-id>
```

| Exit | Meaning | What you do |
|---|---|---|
| 0 `CLAIMED` | The task is yours. Note the `epoch` (your fencing token). | Start. |
| 3 `BUSY` | Someone else holds it. | Do not work on it. Tell the lead with a `BLOCKED` message. |
| 2 | Bad task id. | Check the id in the brief. |

For long tasks, renew before the claim runs out:

```sh
orch task renew <task-id> --expected-epoch <epoch>
```

`STALE_EPOCH`, `NOT_HOLDER` or `EXPIRED` means the task is no longer yours: stop, keep your
changes on your branch, and tell the lead.

## 3. Work

- Work in your own worktree and branch (`orch worker start ... --worktree` gives you one),
  never on the default branch and never in another worker's directory.
- Stay inside the brief. If you cannot tell whether something is inside your scope,
  authority or budget, treat it as outside: stop and ask with a `QUESTION`.
- Decide small implementation details yourself (file placement, test layout, naming) and
  say what you chose in your `DONE` report.
- Budgets in the brief (time, tool calls, money) are hard limits. Running out is `BLOCKED`,
  not `DONE`.

```sh
orch msg send QUESTION --to lead -m "parser-fix: the brief says keep the old flag; the new parser cannot. Drop it or keep a shim?"
orch msg watch --count 1          # wait for the answer
```

## 4. Report DONE with evidence, then release

A `DONE` report is something another agent can check without trusting you. It contains:

1. the task id and your claim epoch;
2. the branch and exact commit (`git rev-parse HEAD`);
3. every verification command you ran, with its output copied verbatim (at least the
   summary lines: test counts, exit codes);
4. what you did not do, skipped, or could not verify;
5. anything the reviewer should look at first.

```sh
orch msg send DONE --to lead -m "$(cat report.md)"
orch task release <task-id> --expected-epoch <epoch>
```

Post the report the moment the task is finished; do not wait for the lead to ask.

## Rules that do not bend

- One claimed task at a time unless the lead says otherwise.
- Never claim "passing" or "fixed" without the command output that shows it.
- Never merge, never approve your own change, never push to the default branch.
- Irreversible or outward-facing actions outside the brief: stop and ask.
