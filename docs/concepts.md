# Concepts

ORCH-os gives a group of CLI coding agents the few shared facts they need to work as one team. Each concept maps to one module and one set of files under `~/.orch` (or `$ORCH_HOME`).

## Roles

A **role** is a job, not a person, a vendor or a model. ORCH-os ships three: the **lead** (plans, splits, hands out, decides, reports), the **worker** (does one claimed task and proves it is done) and the **reviewer** (judges one change independently). Any agent CLI can fill any role. The handbook (`orch init`) has one boot file per role and a shared `protocols.md`.

Every session names itself once: `export ORCH_AGENT=w1`. Messages, claims and notes use that name (`--as` overrides it).

## Role lease and epochs

Only one session may act as lead at a time. The **lease** (`lease.json`) records who holds it and until when.

- `acquire` succeeds when the lease is free, expired, or already yours. A different holder with an unexpired lease makes it fail with exit 3 (`BUSY`) unless `--force` is given.
- Expiry is judged on the **stored** expiry time, not on the duration a caller asks for. Durations below `min_seconds` are raised to it.
- Every change of holder increments the **epoch**. A session that lost the role gets `NOT_HOLDER` on `renew`; `renew --expected-epoch N` (and, new in v2, `release --expected-epoch N`) also fails with `STALE_EPOCH` if the epoch is not the one the caller last saw. Either way the old holder cannot keep acting on the role. This is called fencing.
- Every write happens under an exclusive lock and is read back under the same lock before success is reported.

Example: A acquires (epoch 1). B tries and gets `BUSY`. A releases, B acquires (epoch 2). A late `renew --expected-epoch 1` from A is refused.

## Addressed messages

`orch msg` carries the conversation between roles. A message has a sender, a recipient (one name, or `*` for everyone), a **kind** and a body:

| Kind | Meaning |
|---|---|
| `QUESTION` | The sender needs a decision to continue. |
| `ANSWER` | A decision. It must name the `QUESTION` it answers (`--reply-to ID`). |
| `DONE` | A task is finished; the body is the evidence. |
| `BLOCKED` | The sender cannot continue; the body says what would unblock it. |

Each reader has its own **cursor**. A message stays **pending** for a reader until that reader **acks** it; reading does not ack by itself (`read --ack` does both). Acks are idempotent, and a reader can only ack messages addressed to it. Reader names in messages compare case-insensitively (`Lead` and `lead` are one reader), and so do task ids; holder names in the lease and in claims are compared exactly. `orch msg watch` polls and prints new messages as they arrive, which is how an agent waits for an answer without busy-reading files.

Messages live in `messages.jsonl`, one JSON object per line, numbered by a `seq` that is assigned under the lock. Because every field is JSON-encoded, no body can forge another message.

The older **mailbox** (`mailbox.md`, `orch mailbox`) stays for broadcast notes that nobody has to answer: assignments, status lines, hand-overs. It is one Markdown file with a section per role; entries are inserted under a lock and never edited.

## Task claims

`orch task claim ID` makes you the only holder of task `ID`. A claim is a lease on the task, with the same rules as the role lease: exclusive while unexpired, epoch-fenced, read back before success, exit 3 (`BUSY`) when someone else holds it. There is no `--force`: a claimed task changes hands only by release or expiry. Re-claiming a task you already hold extends it and keeps the epoch. Eight processes racing for one task produce exactly one winner (tested).

The epoch is the claim's **fencing token**: pass it back on `renew` and `release` with `--expected-epoch`, and a holder that lost the task finds out instead of carrying on.

## Approvals, head commits and the merge gate

`orch merge-gate PR` reads the PR's reviews, checks and labels from GitHub and passes only when all of these hold:

1. **CI**: at least one check, and every check concluded SUCCESS, NEUTRAL or SKIPPED.
2. **Approvals**: at least `required_approvals` (default 1) reviewers other than the PR author whose latest decisive review is APPROVED **for the current head commit**.
3. **No changes requested**: no reviewer's latest decisive review is CHANGES_REQUESTED.
4. **Label** (optional): if `required_label` is set, the PR carries it. Off by default.

A decisive review is APPROVED, CHANGES_REQUESTED or DISMISSED; a later one from the same reviewer replaces an earlier one, and COMMENTED reviews are ignored. An approval of an older commit is **stale**: pushing new commits after an approval means the new code needs a new approval. `--head SHA` is an expected-head guard: if the PR has moved since you looked, the answer is `BLOCKED (head moved ...)`.

GitHub does not let a PR author approve their own PR, and the gate ignores such reviews too. If all your agents act through one GitHub account, either give the reviewing agent its own account or a GitHub App identity, or switch the gate to **review comments** (`--reviews comments --task ID`, or `[review] source = "comments"`). A review comment is a PR comment whose first line is `ORCH-REVIEW APPROVE|CHANGES|REJECT <full head sha> by <agent>`, posted with `orch review`. The same rules apply with agents in place of GitHub logins: the author is the holder of the task in `orch task`, a review comment counts only for the current head commit and only from another agent, a later `CHANGES` or `REJECT` blocks, and CI must be green. Review comments are a process gate between cooperating agents, not a security boundary: whoever holds the shared token can post one under any name.

## Workers and worktrees

A **worker** is one background process: an agent CLI given a task on stdin. `orch worker start` requires `timeout` or `gtimeout` without attended `--force`, runs it in a new session (its own process group) with that time limit and optionally with `nice`, and writes `PID`, `worker.json`, `stdout.log` and `stderr.log` under `workers/NAME/`. `orch worker stop` sends SIGTERM to the whole group and SIGKILL after a grace period, and waits until every member is gone (not just the agent itself), so processes the agent started are stopped too, even ones that ignore SIGTERM or outlive the agent. A pid that now belongs to another process (the worker exited, the pid was reused) is never signalled: `PID_REUSED`, detected by comparing the process start time recorded at launch (this also catches a new owner that has exited but not been reaped). One case cannot be detected: if the pid was reused by a process that made itself a group leader, started children, then exited and was reaped, its surviving children form a group with the worker's old id, and `stop` would signal them. Operating systems do not reuse a pid while its group exists, so this needs the worker's whole group to be gone first. Where `ps` cannot be read, a live pid whose start time cannot be checked is treated as reused (nothing is signalled), and groups count as alive so `stop` keeps the worktree (fail closed).

The command comes from, in order: the command after `--`, `--agent NAME` (the `[agents.NAME]` command), or `[workers] command`. The placeholders `{name}` and `{workdir}` are substituted.

With `--worktree`, the worker gets its own **git worktree**: `<worktree_root>/NAME` on branch `orch/NAME` (or `--branch`), created from `HEAD` (or `--base`) of the repository in `--workdir`. If that worktree already exists it is **attached** instead. On `stop`, a worktree that orch created is removed only when every process in the worker's group has exited and `git status --porcelain --untracked-files=all --ignored` shows nothing (so untracked and ignored files, such as a local `.env`, keep it); otherwise it is kept and the reason is reported. The branch is always kept. Attached worktrees are never removed.

## Agent detection

`orch init` looks for known agent CLIs on PATH, then in a few common install directories that cron does not add to PATH. For each one found it writes an `[agents.NAME]` entry with the **absolute** binary path and a headless command that reads the task from stdin. The first one found becomes the default worker command unless you pass `--agent`. `orch agents` shows what is installed and configured.

## Load tiers

`orch load` takes one sample: `load_ratio` (1-minute load average divided by CPU count), `swap_pct`, and `temp_c` only if you configure a `temp_command`. The tier moves between **NORMAL, BUSY, HIGH and CRITICAL**: up after 2 consecutive samples at or above a threshold, down after 3 consecutive samples below the threshold minus a margin, so it does not flap. While the tier is in `[workers] block_tiers` (default HIGH and CRITICAL), new workers are refused unless `--force` is given. With `act = true` and a `renice_pattern`, HIGH and CRITICAL lower the priority of matching processes. Nothing is ever killed.

## Notes that outlive a session

`orch mem` stores what the team should still know next week. Each entry is one Markdown file, `mem/NAME.md`, with a frontmatter block (`name`, `description`, `type`, `status`, `created_at`, and after retiring `superseded_by`, `retired_at`, `retired_reason`) and a free body. `mem/INDEX.md` is generated from the files: one line per active entry, meant to be read at the start of every session. Because it costs context every time, it has a line cap (`[mem] index_max_lines`, default 200): at the cap, `add` still writes but warns.

Entries are never deleted. `orch mem retire OLD --superseded-by NEW` marks the old file retired, records its successor, and drops it from the index; `search --all` still finds it. Adding an entry whose name exists is refused: add a new one and retire the old one.

## The handbook

`orch init` writes the handbook as plain Markdown: three role boot files and `protocols.md` (message kinds, claims, DONE reports with command output, the merge rule, notes, safety lines). The files are yours to edit; `init` keeps them unless you pass `--force-handbook`.

## Failing closed

When information is missing or ambiguous, the answer is "no": no CI checks, an unusable head commit, malformed PR data, a failed `gh` call, a claim held by someone else, a lock that cannot be taken. A wrong "no" costs a retry; a wrong "yes" can merge unreviewed code, let two workers edit the same files, or leave two leads running.
