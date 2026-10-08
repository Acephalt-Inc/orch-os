---
name: protocols
description: The shared rules every role follows - identities, the four message kinds, task claims, DONE reports with command output, the merge rule (N non-author approvals of the current head commit), notes, and safety lines. Read it once per session, whatever your role.
---

# Protocols

These rules are the contract between the lead, the workers, the reviewers and the human.
Every command here is an `orch` command; see `orch <command> --help`.

## Identity and roles

- Every session sets a name once: `export ORCH_AGENT=<name>` (for example `lead`, `w1`,
  `r1`). Messages, claims and reports use it.
- Roles are jobs, not vendors or models. Any agent CLI can fill any role.
- One lead at a time, checked by `orch lease`. The lease epoch fences off a former lead:
  a lead that gets `NOT_HOLDER` or `STALE_EPOCH` stops acting as lead at once. The lease
  is a rule between cooperating sessions. It does not stop a session that ignores it.
- Names, accounts and vendors are declared by the sessions themselves; nothing verifies
  them. A worktree is a working directory, not a sandbox.

## Messages

Addressed messages go through `orch msg`. Each has a sender, a recipient (`--to NAME`, or
`*` for everyone), a kind and a body. Each reader has its own cursor: a message stays
pending for its reader until that reader acks it.

| Kind | Use it when | Must contain | The receiver |
|---|---|---|---|
| `QUESTION` | You need a decision to continue. | The decision needed, the options, your recommendation. | Answers (or explicitly defers) on the pass that sees it. |
| `ANSWER` | You decide a `QUESTION`. | `--reply-to <question id>`; the decision. | Acks it and continues. |
| `DONE` | A task is finished. | A DONE report (below). | Checks the evidence, then acks. |
| `BLOCKED` | You cannot continue and waiting will not fix it. | What blocks you, what you tried, what would unblock you. | Unblocks, reassigns, or escalates. |

```sh
orch msg send QUESTION --to lead -m "Keep the old flag or drop it? Recommend: drop, it has no callers."
orch msg read                        # my pending messages
orch msg ack <id>                    # done with it
orch msg watch --count 1             # wait for the next one
```

Unanswered questions are the most expensive thing in a team: the lead reads pending
messages first in every pass, before anything else.

The shared mailbox (`orch mailbox`) is for broadcast notes that nobody has to answer:
assignments, status, hand-overs. It is append-only; nobody edits an entry.

## Task claims

- Claim before you start: `orch task claim <id>`. Exit 3 (`BUSY`) means someone else holds
  it; do not work on it.
- The claim's epoch is your fencing token. Renew with
  `orch task renew <id> --expected-epoch <epoch>`; a `STALE_EPOCH` answer means the task
  moved on without you.
- Release when done: `orch task release <id> --expected-epoch <epoch>`.
- Silence and old heartbeats never transfer a task. A claim changes hands only by release,
  by expiry, or by an explicit decision from the lead.
- An expired claim does not stop the earlier holder's process and does not prevent its Git
  writes. If your claim is gone, stop writing. If you take over a task, check its branch
  for commits you did not make before you build on it.

## DONE reports

A DONE report is evidence another agent can check without trusting the author:

```text
DONE <task-id> epoch=<n>
branch=<branch> commit=<full sha>
ran:
  $ <command>
  <its output, verbatim, at least the summary lines>
not done / skipped: <list, or "none">
look first at: <file:line or topic>
```

"Tests pass" without the command and its output is not evidence. A report of something
partially done says so in its first line.

## The merge rule

A change merges only when all of these hold at the same moment:

1. CI is green on the change's **current head commit**;
2. at least **N** approvals (default 1, `[merge] required_approvals`) from reviewers who are
   **not the author**, each for that **current head commit**;
3. no reviewer's latest review requests changes.

Check it as a separate step and read the answer before doing anything:

```sh
orch merge-gate <pr> --head <sha-you-reviewed>
```

- Any push makes earlier approvals stale; the new head needs new approvals.
- "Approve after fixes" is not an approval.
- If every agent uses one code-host account, approvals are review comments instead:
  `orch review approve <pr> --as <you> --head <sha>` posts one, and
  `orch merge-gate <pr> --reviews comments --task <id>` checks them. The same rules hold,
  with agent names in place of accounts. Review comments are a process rule between cooperating
  agents; the account's token can post any name, so never post one for another agent.
- Who performs the merge is the human's decision, and unless the human has said otherwise
  the human performs it. Agents merge only when the human has said so for this change or
  this class of change, and only on a `PASS`. No `orch` command merges.

## Notes that outlive a session

`orch mem` keeps what the team should still know next week: rules, lessons, facts, pointers.

- One fact or rule per entry: `orch mem add <name> --type rule -d "<one line>" -m "<why, and how to apply it>"`.
- Read `mem/INDEX.md` at the start of every session. It has a line cap because it costs
  context every time; when `add` warns about the cap, retire or merge entries.
- When something stops being true, retire it:
  `orch mem retire <old> --superseded-by <new>`. The file is kept, marked retired, and
  drops out of the index.

## Safety lines

- Irreversible or outward-facing actions (deleting data, force-pushing shared branches,
  publishing, messaging people outside the team, spending money) are proposed to the
  human before they happen.
- Budgets in a brief are hard limits.
- Secrets never go into messages, the mailbox, notes or reports.
- When unsure whether something is allowed, it is not: ask with a `QUESTION`.

## Loading these files into your agent

`orch init` writes this handbook to `~/.orch/handbook/` (or `--dir`). Point each session at
its role file:

- Agent CLIs that load skill folders: `orch init --layout skills --dir <skills dir>` writes
  `<name>/SKILL.md` folders; start a session and invoke `lead-boot`, `worker-boot` or
  `review-boot`.
- Any agent CLI with an instructions file (for example `AGENTS.md` or `CLAUDE.md`): add a
  line such as "At session start, read ~/.orch/handbook/protocols.md and the boot file for
  your role, then follow it."
- Headless workers started with `orch worker start`: put "Follow ~/.orch/handbook/worker-boot.md"
  at the top of the task file.
