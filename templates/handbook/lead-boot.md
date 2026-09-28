---
name: lead-boot
description: Start this session as the LEAD - take the lead lease, catch up on state, answer open questions, then plan and hand out work. Run it at the start of every session that should lead a team of agents.
---

# Lead boot

The lead plans, splits work into tasks, hands them to workers, keeps reviews honest and
reports to the human. The lead does not do large implementation work itself: its context is
the team's scarcest resource. Run the steps in order.

## 0. Name yourself

```sh
export ORCH_AGENT=lead            # every orch command below uses this name
```

## 1. Take the lead lease (one lead at a time)

```sh
orch lease acquire --session "$ORCH_AGENT"
```

| Exit | Meaning | What you do |
|---|---|---|
| 0 | You hold the lead role. Note the `epoch` it printed. | Continue. |
| 3 `BUSY` | Another session holds an unexpired lead lease. | Do **not** pass `--force` on your own. Tell the human; boot as a worker (`worker-boot`) unless they decide otherwise. |
| other | Lock or config problem. | Run `orch doctor`, fix, retry. |

Renew while you work, fenced by the epoch you were given:

```sh
orch lease renew --session "$ORCH_AGENT" --expected-epoch <epoch>
```

`NOT_HOLDER`, `EXPIRED` or `STALE_EPOCH` means you are no longer the lead. Stop every lead
action at once (no dispatching, no merge decisions) and tell the human.

## 2. Catch up before acting (read only)

```sh
cat "${ORCH_HOME:-$HOME/.orch}/mem/INDEX.md"    # standing rules and lessons
orch msg read                                   # pending messages to lead, oldest first
orch task list                                  # who holds what, and until when
orch worker list                                # which workers are running
orch mailbox read -n 20                         # recent broadcast notes
git worktree list                               # work in progress on disk
gh pr list --state open                         # open pull requests, if you use GitHub
```

Work that was in progress when the last session ended comes first: resume it, do not start
it again. A stopped process loses nothing that is on disk.

## 3. Priority zero: open questions

Every pending `QUESTION` and `BLOCKED` message gets an `ANSWER` (or an explicit "deferred,
because ...") in this session, before any new work is handed out:

```sh
orch msg send ANSWER --to w1 --reply-to <question-id> -m "Use the existing parser; no new dependency."
orch msg ack <question-id>
```

If the question is about scope, authority, money or anything irreversible, it goes to the
human. Do not decide it yourself.

## 4. Plan and hand out work

State the plan in one to three sentences, split it into tasks with
one owner each, write each task brief, and start workers:

```sh
orch mailbox post LEAD -m "w1: task parser-fix (brief: briefs/parser-fix.md)"
orch worker start w1 --agent <agent> --worktree --task briefs/parser-fix.md
```

The brief itself tells the worker to claim the task (`orch task claim parser-fix`) and to
report with `DONE`, `BLOCKED` or `QUESTION` messages to `lead`.

## 5. The loop

Until the human ends the session, on a fixed cadence (every 5-10 minutes while work is
active, less often when quiet):

1. renew the lead lease with `--expected-epoch`;
2. `orch msg read`: answer questions, check every `DONE` against its evidence, unblock `BLOCKED`;
3. `orch worker list` and `orch task list`: an idle worker gets the next task now;
4. `orch load`: at `HIGH` or `CRITICAL`, start nothing new;
5. merge decisions only through the gate in `protocols.md`.

Report to the human in three short parts: the result, what you need from them, what happens
next. Say plainly what failed or was skipped.

## Rules that do not bend

- One lead. Taking the lease from a live holder is the human's decision, never yours.
- The lead does not approve its own work and does not merge on its own judgment.
- A `DONE` without evidence (commands and their output) is not done: ask for the evidence.
- Irreversible or outward-facing actions (deleting data, publishing, messaging people,
  spending money) are proposed to the human first.
