# Command reference

All commands read `$ORCH_HOME/config.toml` (default `~/.orch/config.toml`). Read-only commands use built-in defaults when the file does not exist yet. A malformed config gives exit 2 with a one-line message. Every command accepts `-h`/`--help`; a usage error exits 2.

| Environment variable | Effect |
|---|---|
| `ORCH_HOME` | State and config directory (default `~/.orch`) |
| `ORCH_AGENT` | Your name for `msg` and `task` when `--as` is not given |
| `ORCH_SESSION_ID` | Default `--session` for `lease`; second fallback for `--as` (then `user@host`) |
| `ORCH_AGENT_DIRS` | Colon-separated dirs searched for agent CLIs after PATH; empty string = PATH only |

Exit codes shared by all commands: `0` ok · `1` a "no" answer (`doctor` FAIL, `merge-gate` BLOCKED, `mem search` no hits) or an unexpected error · `2` usage, input or config error, including a lock that could not be taken within 30 s · `3` `BUSY` · `4` `NOT_HOLDER`, `EXPIRED`, `STALE_EPOCH` · `5` `UNVERIFIED` (read-back did not match, or the lock was lost) · `6` `CORRUPT` / `UNKNOWN` ownership (the named file cannot establish a safe owner or epoch).

## orch init

```text
orch init [--force] [--agent NAME] [--dir DIR] [--layout flat|skills] [--force-handbook] [--no-handbook]
          [--compute one|same-vendor|multi-vendor --people solo|team | --no-profile]
```

Detects agent CLIs, writes `config.toml` (unless it exists and `--force` is not given), creates `workers/` and the mailbox file, and writes the handbook. The message, task and notes directories are created on first use. Prints one `agent NAME PATH` line per detected agent and marks the default.

| Flag | Meaning |
|---|---|
| `--force` | Rewrite `config.toml` from defaults plus fresh detection (mailbox, messages, tasks and notes are kept) |
| `--agent NAME` | Make NAME the default worker agent. Exit 2, nothing written, if NAME was not detected |
| `--dir DIR` | Write the handbook to DIR instead of `[handbook] dir` |
| `--layout` | `flat` (default): `DIR/NAME.md`. `skills`: `DIR/NAME/SKILL.md` |
| `--force-handbook` | Overwrite handbook files that already exist (they are kept by default) |
| `--no-handbook` | Do not write the handbook |
| `--compute V --people V` | Write a `[profile]` (see [orch profile](#orch-profile)) without asking. The two go together: either alone is exit 2. The detected agent CLIs fill `[profile.accounts]` (`acct1`, `acct2`, ...) |
| `--no-profile` | On a terminal, skip the two profile questions and write no `[profile]` |

**Profile questions.** When stdin is a terminal and `config.toml` is being written, `init` asks after detection: "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs?" (`1`/`2`/`3`, default `1`) and "Solo, or with teammates?" (`solo`/`team`, default `solo`), then writes a `[profile]`. Three unusable answers, or end of input, write no profile. When stdin is not a terminal, `init` asks nothing and writes exactly the config it wrote before profiles existed. `--force` keeps an existing `[profile]` byte for byte (unless `--compute`/`--people` replace it). When `config.toml` exists and `--force` is not given, `--compute`/`--people` is exit 2 and the file is not touched: use `orch profile update`.

## orch agents

```text
orch agents [--json]
```

Lists every known agent CLI as `found`, `found (off PATH)` or `absent`, whether it is `configured`, and any custom `[agents.*]` entries.

## orch doctor

```text
orch doctor
```

One row per check: `PASS`, `FAIL` (required) or `SKIP` (optional). Exit 0 when no required check fails, else 1.

| Check | Required |
|---|---|
| Node.js ≥ 20, POSIX platform, config readable, state dir writable, lease lockable, mailbox writable, sections configured, messages dir, task registry, mem dir, `git` on PATH | yes |
| handbook files present, `gh`, merge repo set, worker command on PATH, `timeout`/`gtimeout`, agent CLIs found, each `[agents.*]` binary present | no (SKIP) |
| load state | informational |
| profile rows (only when `config.toml` has a `[profile]` table) | `profile` FAIL when the table is invalid; every other profile row is `PASS` or `SKIP` |

With a `[profile]`, doctor adds one row per profile check. A missing capability is a `SKIP` row that says what is off, for example `SKIP  profile accounts  same-vendor declared, but only one account is listed in [profile.accounts]; reviews count as single-agent and nothing merges automatically until a second account is added`. The rows are `profile` (the effective cell and the accounts), `profile accounts`, `profile vendors`, `profile vendor NAME` (a CLI found or an `[agents.NAME]` configured), `profile teammates`, `profile teammate reviews` (`gh` and `[merge] repo`), `profile reviewers` (agents on at least two accounts) and `profile agents` (`[agents.*]` names without an account in `[profile.agents]`). Without a `[profile]`, doctor prints the same rows as before.

## orch config

Prints the resolved configuration as JSON, with the file it came from.

## orch lease

```text
orch lease {status|acquire|renew|release} [--session ID] [--seconds N] [--expected-epoch N] [--force] [--recover] [--json]
```

| Action | Result status |
|---|---|
| `status` | `HELD` or `FREE` |
| `acquire` | `ACQUIRED`; a new holder increments the epoch |
| `renew` | `RENEWED`; with `--expected-epoch`, refused (`STALE_EPOCH`) if the epoch moved |
| `release` | `RELEASED`; with `--expected-epoch`, refused if the epoch moved |

Output: `lease STATUS holder=... epoch=N expires_in=Ns`. `--force` takes over an unexpired lease and records `forced_takeover`. `--seconds` below `[lease] min_seconds` is raised to it.

An existing file with invalid JSON, a non-object value, or an invalid lease object is `CORRUPT`; an unreadable file (including a directory or dangling symlink) is `UNKNOWN`. Every lease action refuses with exit 6 and names the file on stderr. `--force` cannot bypass this refusal. `acquire --recover` is the only recovery command; using `--recover` with another action gives exit 2. Recovery of a healthy lease follows normal holder/expiry rules.

Every successful store first persists `<lease path>.epoch.max`, a JSON record of the highest reserved epoch and known holders, then publishes the lease under the same lock. Recovery uses the maximum of that record and any valid epoch readable in the damaged object, plus one: epoch 7 becomes 8 even if the lease JSON is unparseable. Recovery refuses when neither source supplies an epoch, or when the record is damaged/unreadable; it never guesses 1. An exhausted safe-integer epoch also refuses. Healthy legacy leases gain a record on their next successful write. A crash between reservation and lease publication skips the reserved epoch; deleting only the lease retains the floor. Preserve the sidecar with the lease; deleting both discards the evidence needed for fencing.

Explicit recovery keeps the damaged file/directory at a unique `<path>.corrupt-<time>-<uuid>` path and fsyncs journal lines to `<path>.recovery.jsonl`. `PREPARED` records what was found, the evidence path, and the intended lease; `COMMITTED` records the published lease. A lone `PREPARED` means publication may not have completed. Journal/epoch/evidence failures abort the operation; retries may skip another epoch.

Locks and fencing cover a single local host. A living same-host PID, including one paused by SIGSTOP, never becomes stale by age. A dead local PID can be reclaimed immediately; a foreign host's record can be aged out, but this is no multi-host or NFS safety promise. Missing `owner.json` retains the initialization grace period; unreadable or malformed owner records block all lock-protected callbacks with exit 6. Owner publication and stale-directory removal share the same exclusion, so an initializer cannot publish between the breaker’s stale check and rename. Lock tokens are checked before atomic writes, again before atomic publication, and before direct message appends; detected loss gives exit 5 before that effect. A leftover breaker directory is never removed by age while its holder could be paused; contention times out instead. These checks do not fence arbitrary external programs writing the files without these locks.


## orch msg

```text
orch msg send KIND --to NAME|* [-m TEXT] [--reply-to ID] [--from NAME] [--as NAME] [--json]
orch msg read  [--as NAME] [--all] [--ack] [-n N] [--json]
orch msg ack   [ID ...] [--all] [--as NAME]
orch msg watch [--as NAME] [--interval S] [--timeout S] [--count N] [--ack] [--json]
```

| Subcommand | Does |
|---|---|
| `send` | Appends one message. `KIND` is `QUESTION`, `ANSWER`, `DONE` or `BLOCKED` (case-insensitive). The body comes from `-m` or stdin (max 64 KiB, not empty). `ANSWER` needs `--reply-to` naming an existing `QUESTION`. Prints `sent KIND ID seq=N to=NAME`. |
| `read` | Prints your pending messages, oldest first. `--all` includes acked ones, `-n N` keeps the newest N (0 = all), `--ack` acks what was printed. |
| `ack` | Acks the given ids, or every pending one with `--all`. Acking twice is harmless; an id that is not addressed to you gives exit 2. |
| `watch` | Polls every `--interval` seconds (default `[messages] poll_seconds`) and prints each new pending message once. Stops after `--timeout` seconds or `--count` messages, else runs until interrupted. |

Your inbox is every message whose `to` is your name (compared case-insensitively), plus broadcasts (`to = *`) sent by others. Human output is `--- #SEQ KIND from=A to=B [re=ID] id=ID TIMESTAMP` then the body; C0 and C1 control characters other than tab and newline (including `\r` and escape sequences), U+2028, U+2029, bidi marks, embeddings, overrides and isolates, and U+FEFF are shown as `\xNN` or `\uNNNN`, and body lines starting with `---` or `\` are shown with a leading `\`. `--json` prints the stored objects: `{seq, id, ts, from, to, kind, reply_to, body}`.

## orch task

```text
orch task claim   ID [--as NAME] [--seconds N] [--recover] [--json]
orch task renew   ID [--as NAME] [--seconds N] [--expected-epoch N] [--json]
orch task release ID [--as NAME] [--expected-epoch N] [--json]
orch task status  ID [--json]
orch task list       [--json]
```

Output: `task ID STATUS holder=... epoch=N expires_in=Ns`. Status and exit codes follow the lease: `CLAIMED` (0), `RENEWED` (0), `RELEASED` (0), `HELD`/`FREE` for `status`, `BUSY` (3), `NOT_HOLDER`/`EXPIRED`/`STALE_EPOCH` (4), `UNVERIFIED` (5), `CORRUPT`/`UNKNOWN` (6). There is no `--force`. A task id is letters, digits, `_ . @ -`, not starting with a dot, and is case-insensitive (stored in lower case). `list` prints every task file as `CLAIMED`, `EXPIRED`, `RELEASED`, `FREE`, `CORRUPT` or `UNKNOWN`, and exits 6 if any claim is damaged.

Task files use the same epoch/history sidecar, refusal and journal rules as the lead lease. Only `task claim ID --recover` can recover damaged ownership, and only with a known epoch floor. Recovery preserves the known author history from the sidecar and any readable history in the damaged object; an unknown claim supplies no authors to the comments-mode merge gate. Moving a damaged claim aside by hand is unnecessary. Preserve its sidecar: it prevents epoch reset and loss of past task authors.

## orch mailbox

```text
orch mailbox post SECTION [-m TEXT] [--author NAME]     # body from -m or stdin
orch mailbox read [-n N] [--section SECTION]
```

`post` prints the new entry id; an unknown section or empty body gives exit 2. Sections are case-insensitive. `read` prints the newest N entries (default 10), oldest first; control characters in timestamps and bodies are shown as `\xNN` (U+2028, U+2029, bidi marks, embeddings, overrides and isolates, and U+FEFF as `\uNNNN`).

## orch merge-gate

```text
orch merge-gate PR [--repo OWNER/NAME] [--head SHA] [--approvals N] [--label NAME] [--fixture NAME|PATH] [--reviews github|comments] [--task ID]
                   [--tier low|high] [--auto] [--json]
```

Prints the head, CI state, approvals (with stale and self counts), changes requested and label state, then `=> PASS` (exit 0) or `=> BLOCKED` (exit 1). Live mode runs `gh pr view PR --repo REPO --json author,headRefOid,reviews,labels,statusCheckRollup`; any error prints `BLOCKED (...)` and exits 1. `--head` makes the gate block with `head moved` when the PR is at a different commit.

`--reviews` picks where approvals come from (default `[review] source`, else `github`). With `github`, the output and behaviour are those of v2.0.1. With `comments`:

- live mode also fetches `comments`;
- `--task ID` is required: the agents recorded for that task in `orch task` (every agent that has held it: task files keep an append-only `holders` list; a file written before it existed gives its holder and previous holder) are the PR's authors. No task, or a task with no holder, is `BLOCKED`. The GitHub login is never used as an identity;
- a **review comment** is a PR comment whose first line is exactly `ORCH-REVIEW APPROVE|CHANGES|REJECT <40-character lower-case head sha> by <agent>` (trailing whitespace ignored; anything after the first line is free text). A first line that starts with `ORCH-REVIEW` in any case, after optional leading spaces, but is not exactly that shape is counted as `malformed`, reported as a warning on stderr, and never counted as a verdict;
- a review comment counts only when its sha is the PR's current head (otherwise `stale`) and its agent is not an author (otherwise `self`; names compare case-insensitively). Per agent, the latest counting review comment (in comment order) is the one that holds;
- the gate passes when CI is green, at least N agents' latest review comment is `APPROVE`, no agent's latest review comment is `CHANGES` or `REJECT`, no non-author GitHub reviewer has an open `CHANGES_REQUESTED`, and the label rule holds. GitHub approvals do not count in this mode.

This is a process gate between cooperating agents that share one account, not a security boundary: anyone with the account's token can post a review comment under any name.

```text
#101 head=4f2c9a1e7 ci=green reviews=comments author=w1 approvals=1/1 [r1] (stale=0 self=0 malformed=0) changes_requested=0 label=off
=> PASS
```

| Fixture | Shows |
|---|---|
| `approved` | One non-author approval of the head commit, CI green: `PASS` |
| `stale-approval` | The only approval is for an older commit |
| `self-approval` | Only the PR author approved |
| `changes-requested` | One approval, but another reviewer requested changes |
| `ci-red` | A failing check |
| `comment-approved` | No GitHub review; one `ORCH-REVIEW APPROVE` review comment by `r1` at the head. `PASS` with `--reviews comments --task ID` when the task's holder is not `r1`; `BLOCKED` in the default `github` mode |
| `teammate-approved` | Approvals at the head by `bob` and by `carol` (list `carol` in `[profile] teammates` to see a teammate approval) |
| `teammate-stale` | `bob` approved the head; `carol` approved an older commit |
| `high-path` | `approved`, plus a changed-file list with `migrations/0042_add_index.sql` (try `high_paths = ["migrations/**"]`) |

**With a profile.** When `config.toml` has a `[profile]` table, the gate first applies every rule above, then grades the approvals it counted and applies the profile's policy for the PR's tier. One line goes between the summary and the verdict:

```text
#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=C tier=high(path: migrations/0042_add_index.sql) review=cross-account needed=cross-vendor teammate=n/a authority=owner
=> BLOCKED (review strength cross-account is below cross-vendor)
```

- **Tier**: `--tier` if given; else `high` when any changed file matches a `[profile] high_paths` glob (`*` and `?` stay inside one path segment, `**` crosses `/`); else `[profile] default_tier` (default `high`). A leading `/` in a glob is dropped (globs are relative to the repository root). Live mode adds `files,changedFiles,number` to the field list only when `high_paths` is not empty, then reads the full list with `gh api --paginate repos/OWNER/NAME/pulls/N/files` (`gh pr view` stops at 100 files). The list counts as read only when its length equals the PR's `changedFiles`; a fetch error, a missing count or a mismatch makes the tier `high`. A fixture needs `files` and a matching `changedFiles`. The line says where the tier came from: `flag`, `path: FILE`, `default` or `files unreadable`.
- **Review strength** of each counted agent approval: `single-agent` (reviewer and author on one account), `cross-account` (different accounts, same vendor) or `cross-vendor`; `single-agent (unmapped)` when the reviewer or an author is not in `[profile.agents]`. With several authors (a hand-off), the weakest holds; across approvals, the strongest holds (`none` without one). The author is the PR author login (`github`) or every task holder (`comments`). A teammate's GitHub approval is not an agent approval.
- **Teammate**: `approved` when a login listed in `[profile] teammates` has an `APPROVED` GitHub review at the head (never the PR author), `missing`, or `n/a` in a solo profile. It is read from the `reviews` field in both review sources.
- **Passes** when the plain rule passes, the strength reaches `needed`, a required teammate approval is there, and, with `--auto`, the merge authority is `auto`. The verdict names each failed condition, and `missing: ...` when a degrade rule applied (the line then ends `degraded=CODES`). A pass under `owner` authority says `the owner decides the merge`.
- `--auto` means the caller merges automatically on `PASS`: it passes only under `auto` authority. `--json` adds one `profile` object: `cell, declared_cell, tier, tier_source, achieved, needed, teammate, need_teammate, authority, worker_cap, degraded, reasons`; existing keys keep their meaning, and `ok` is the combined verdict.
- Without a `[profile]`, `--tier` and `--auto` are exit 2, and the output is byte for byte what it was before profiles.

## orch review

```text
orch review approve|changes|reject PR [--as NAME] [--head SHA] [--repo OWNER/NAME] [-m TEXT] [--dry-run]
```

Posts a review comment for `merge-gate --reviews comments`: `gh pr comment PR --repo REPO --body "ORCH-REVIEW <APPROVE|CHANGES|REJECT> <sha> by NAME"`, with `-m` text after a blank line. NAME is `--as`, then `$ORCH_AGENT`, then the session id. Without `--head`, the PR's live head is read with `gh pr view PR --json headRefOid`; pass `--head` with the full 40-character sha you actually reviewed to be sure the review comment names it. `--dry-run` prints the comment instead of posting it. A bad sha or name exits 2; a `gh` failure exits 1.

## orch review watch

```text
orch review watch PR --task ID [--repo OWNER/NAME] [--tier low|high] [--once] [--dry-run] [--force] [--interval S] [--timeout S] [--json]
```

Waits until CI is green at the PR's head commit, then starts one reviewer agent for that head. The reviewer posts its own review comment (`orch review approve|changes PR --as NAME --head SHA`); watch then checks that a line from that agent names the head. It never merges and never posts a review itself.

Configure the reviewers in `config.toml`:

```toml
[review.agents.rx]
cmd = ["codex", "exec", "-"]                   # argv, no shell; placeholders {pr} {head} {repo} {agent} {prompt}
vendor = "codex"
account = "a2"

[review.agents.rc]
cmd = 'claude -p < "$ORCH_REVIEW_PROMPT"'       # a string runs through /bin/sh; values only in the environment
vendor = "claude"
account = "a1"

[review.watch]
require_ci = true      # false: a repository without CI; a pending or failed check still blocks
stale_minutes = 30     # a reviewer with no review line by then is STALE; also its worker time limit
poll_seconds = 60
```

The reviewer must be allowed to run `gh` and `orch`: add whatever permission flags your agent CLI needs to the command.

One pass:

1. `--task ID` names the PR's task: every agent that has held it is an author and is never chosen (the same rule as `merge-gate --reviews comments`). No `--task`, or a task with no holder: `BLOCKED`.
2. `gh pr view PR --json headRefOid,state,comments` gives the head. A closed or merged PR is `BLOCKED`.
3. If this head already has a reviewer (state file below), watch only follows it: `REVIEWED` once a comment whose first line is `ORCH-REVIEW <verdict> <head> by <that agent>` appears (a line for another commit does not count), `STALE` after `stale_minutes`, else `DISPATCHED`. It never starts a second reviewer for one head unless `--force`.
4. The reviewer: every `[review.agents.NAME]` that is not an author and whose command is on `PATH`, graded against the authors: `cross-vendor`, then `cross-account`, then `single-agent (fresh context)` (same account: a new session, labelled so), then `single-agent (unmapped)` (vendor or account not declared). The strongest wins; ties go to the first in `config.toml`. An agent's account is `account`, else its `[profile.agents]` entry; its vendor is the account's vendor in `[profile.accounts]`, else `vendor` (a contradiction is a config error). With a `[profile]`, the needed strength is the policy's for the PR's tier (`--tier`, `high_paths`, `default_tier`, as in `merge-gate`); a best reviewer below it is `BLOCKED` with the reason, never a weaker review. So cells A and D give a labelled single-agent review when only the author's account is available, and cells B, C, E and F block.
5. CI is read for the head commit only: `gh api repos/OWNER/NAME/commits/SHA/check-runs` and `.../commits/SHA/status`, keeping only the rows whose sha is the head. Any failed or pending check: `WAITING`, no reviewer. No check at all: `WAITING` too (CI may not have started), unless `require_ci = false`.
6. Otherwise watch writes a prompt file and starts the reviewer as a worker named `review-PR-SHA12` (see `orch worker`: own process group, logs, time limit of `stale_minutes`, refused under a blocking load tier). The prompt is on its stdin and in `{prompt}`; the environment has `ORCH_AGENT`, `ORCH_REVIEW_PR`, `ORCH_REVIEW_HEAD`, `ORCH_REVIEW_REPO` and `ORCH_REVIEW_PROMPT`.

A new head means a new pass from step 3: a new reviewer once its CI is green. A reviewer still running for the old head is left alone; its line names the old sha and does not count.

```text
#7 head=4f2c9a1e7 ci=pending => WAITING (CI pending at the head: test=IN_PROGRESS)
#7 head=4f2c9a1e7 ci=green => DISPATCHED (started rx (cross-vendor) as worker review-7-4f2c9a1e7b3d)
#7 head=4f2c9a1e7 => REVIEWED (ORCH-REVIEW APPROVE 4f2c9a1e7b3d... by rx (cross-vendor))
```

Without `--once`, watch repeats every `--interval` seconds (default `poll_seconds`), printing a line when the status changes, until `REVIEWED` (exit 0), `STALE` or `BLOCKED` (exit 1), or `--timeout` (exit 1). `--once` makes one pass for cron: exit 0 for `WAITING`, `DISPATCHED` or `REVIEWED`, 1 for `BLOCKED`, `STALE` or a `gh` error. `--dry-run` makes one pass, prints the chosen reviewer and its command, and starts nothing and writes nothing. `--json` prints each result as JSON. A bad PR number, a bad config value, or `--tier` without a `[profile]` exits 2.

State: one file per PR, `$ORCH_HOME/review-watch/OWNER__NAME__PR.json` (head, agent, label, worker, pid, time, status `dispatched|reviewed|stale`, earlier heads), written under the lock. `orch doctor` shows a `SKIP` row per reviewer command and per stale reviewer; with no `[review.agents]` and no state it shows nothing new.

Like the comments gate, this is a process gate between cooperating agents, not a security boundary: accounts and vendors are declared, not verified.

## orch worker

```text
orch worker start NAME [--task FILE] [--workdir DIR] [--minutes M] [--agent A]
                       [--worktree [--branch B] [--base REF]] [--force] [-- CMD ...]
orch worker list
orch worker stop NAME [--keep-worktree]
```

With a `[profile]`, `start` also refuses (exit 2) when the running workers already reach the profile's worker cap (see [orch profile](#orch-profile)); `--force` starts one anyway. Without a profile there is no cap.

`start` runs the worker detached and prints its pid, load tier and directory, plus a `worktree PATH branch=B (created|attached)` line with `--worktree`. It refuses (exit 2) when NAME is already running, the load tier blocks it (unless `--force`), the command is not on PATH, `--agent` is unknown, both `--agent` and `-- CMD` are given, or the worktree cannot be created (not a git repository, the branch is checked out elsewhere, the path exists but is not a worktree). `--minutes 0` disables the time limit.

With `--worktree`, `--workdir` names the repository (default: the current directory); the worker runs in `<[workers] worktree_root>/NAME` on branch `<worktree_branch_prefix>NAME` or `--branch`, created from `--base` (default `HEAD`). An existing worktree at that path is attached, not recreated.

`list` prints `RUNNING` (the worker, or members of its process group left after it exited, still run), `STOPPED` or `UNKNOWN` per worker. `start` also refuses while members of the previous run's group still run. `stop` signals the whole process group, including members left behind after the agent exited, and prints `TERMINATED` (the group exited after SIGTERM), `KILLED`, `NOT_RUNNING` or `PID_REUSED`, then what happened to the worktree: `worktree removed PATH (branch B kept)` when orch created it and it was clean, otherwise `worktree kept PATH (...)` with the reason (`dirty: N changed, M ignored path(s)`, `process group P still running` when a member survives SIGKILL, `attached, not created by orch`, `--keep-worktree`, or the git error). Branches are never deleted.

## orch load

```text
orch load [--read] [--json]
```

Takes one sample, advances the tier and prints `load tier=... load_ratio=... swap=...% temp=... reniced=N`. `--read` prints the stored state without sampling.

## orch mem

```text
orch mem add NAME -d DESCRIPTION [-t TYPE] [-m BODY]     # body from -m or stdin (optional)
orch mem search [TERM ...] [-t TYPE] [--all] [--json]
orch mem retire NAME (--superseded-by NEW | --reason TEXT)
```

| Subcommand | Does |
|---|---|
| `add` | Writes `mem/NAME.md` and regenerates `INDEX.md`. NAME is letters, digits, `_ . @ -` (not `INDEX`, no leading dot). The description is one non-empty line. TYPE is one word (default `note`; for example `rule`, `lesson`, `fact`, `reference`). An existing NAME gives exit 2. At or over `[mem] index_max_lines` the entry is still written and a warning goes to stderr. |
| `search` | Active entries whose name, description, type or body contain every term (case-insensitive), oldest first. `--all` includes retired entries. Exit 1 when nothing matches. |
| `retire` | Sets `status: retired`, `retired_at`, and `superseded_by` and/or `retired_reason` in the file, and drops it from the index. The file is kept. The successor must exist and be active. |

## orch profile

```text
orch profile show [--json]
orch profile update [--compute V] [--people V] [--account ID=VENDOR]... [--remove-account ID]... [--agent NAME=ID]... [--remove-agent NAME]...
                    [--teammate LOGIN]... [--remove-teammate LOGIN]... [--high-path GLOB]... [--remove-high-path GLOB]...
                    [--default-tier low|high] [--lead-account ID] [--max-workers N] [--dry-run]
```

A profile records the setup: **compute** (`one` account, several accounts on the `same-vendor` agent CLI, or `multi-vendor`) and **people** (`solo`, or a `team` whose teammates approve on GitHub). The six combinations are cells A to F. The design is in [profiles.md](profiles.md). Per tier, the policy is:

| Cell | Compute · people | Low tier: review, teammate, authority | High tier: review, teammate, authority |
|---|---|---|---|
| A | one · solo | single-agent, no, owner | single-agent, no, owner |
| B | same-vendor · solo | cross-account, no, auto | cross-account, no, owner |
| C | multi-vendor · solo | cross-account, no, auto | cross-vendor, no, owner |
| D | one · team | single-agent, yes, teammate | single-agent, yes, teammate |
| E | same-vendor · team | cross-account, no, auto | cross-account, yes, teammate |
| F | multi-vendor · team | cross-vendor, no, auto | cross-vendor, yes, teammate |

`auto`: automation may merge on `PASS`. `owner`: `PASS` means the review rule is met; a person decides and merges. `teammate`: the gate requires a teammate's approval. Worker cap: 1 in cells A and D; otherwise `workers_per_account` × (accounts − 1), at least 1; `max_workers` above 0 replaces it.

**Degrade rules.** The effective cell follows what `[profile.accounts]` backs: fewer than two accounts drops to the `one` column (A or D); `multi-vendor` with one vendor drops to `same-vendor` (B or E). When a degrade applies, or the agents in `[profile.agents]` sit on fewer than two accounts, `auto` authority becomes `owner` (solo) or `teammate` (team, with a teammate approval required). `auto` is never reached through a degrade. A `team` with no teammates listed blocks every rule that needs a teammate.

`show` prints the effective cell (and the declared one when a degrade applied), the accounts, agents, teammates, tier settings, the policy for `low` and `high`, and each missing capability. Without a `[profile]` it prints `profile: not set (merge gate uses the plain rule)` and exits 0; `--json` prints `{"profile": null}`.

`update` changes only the `[profile]`, `[profile.accounts]` and `[profile.agents]` tables. The new tables replace the old ones in place (appended after one blank line when there were none); comments and blank lines just above the next table stay, and every other byte of `config.toml` is kept. The new tables use the file's line endings (CRLF when its first line ends in CRLF). The result is validated and read back before it is written: a bad value, or a profile that is not written as plain tables, is exit 2 with nothing written. Creating a profile needs both `--compute` and `--people`. Removing something that is not there is exit 2. `--dry-run` prints the new tables instead.

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `[orch] team` | `my-team` | Free-form label |
| `[mailbox] path`, `sections` | `~/.orch/mailbox.md`, `LEAD WORKER REVIEWER SYSTEM` | Mailbox file and its sections |
| `[lease] path`, `default_seconds`, `min_seconds` | `~/.orch/lease.json`, `3600`, `60` | Lease file and durations |
| `[messages] path`, `cursors`, `poll_seconds` | `~/.orch/messages.jsonl`, `~/.orch/cursors`, `5` | Message log, per-reader cursor dir, `watch` interval |
| `[tasks] dir`, `default_seconds`, `min_seconds` | `~/.orch/tasks`, `7200`, `60` | Task claim files and durations |
| `[mem] dir`, `index_max_lines` | `~/.orch/mem`, `200` | Notes directory; index line cap |
| `[handbook] dir` | `~/.orch/handbook` | Where `init` writes the handbook |
| `[merge] repo`, `required_approvals`, `required_label` | `""`, `1`, `""` | Live-mode repo; approvals needed at the head; optional label |
| `[review] source` | `github` | Where `merge-gate` approvals come from: `github` reviews, or `comments` (ORCH-REVIEW comments; needs `--task`) |
| `[review.agents.NAME] cmd`, `vendor`, `account` | none | A reviewer for `review watch`: argv or shell command line; declared vendor and account (the account's vendor in `[profile.accounts]` wins) |
| `[review.watch] require_ci`, `stale_minutes`, `poll_seconds`, `dir` | `true`, `30`, `60`, `~/.orch/review-watch` | `false` = no CI expected; when a silent reviewer is stale; loop interval; state files |
| `[workers] root`, `command`, `timeout_minutes`, `nice`, `block_tiers` | `~/.orch/workers`, first detected agent, `60`, `5`, `HIGH CRITICAL` | Worker defaults |
| `[workers] worktree_root`, `worktree_branch_prefix` | `~/.orch/worktrees`, `orch/` | Where `--worktree` puts worktrees; default branch prefix |
| `[agents.NAME] command` | written by `init` | Command for `worker start --agent NAME` |
| `[load] state`, `busy`, `high`, `critical` | `~/.orch/load.json`; `load_ratio` 0.75 / 1.0 (+ `swap_pct` 90) / 1.5 | Tier thresholds (`load_ratio`, `swap_pct`, `temp_c`) |
| `[load] temp_command`, `renice_pattern`, `act` | `""`, `""`, `false` | Optional temperature probe; optional renice under HIGH/CRITICAL |
| `[profile] compute`, `people` | none (required in a `[profile]`) | `one` / `same-vendor` / `multi-vendor`; `solo` / `team`. No `[profile]` table = no profile |
| `[profile] lead_account`, `default_tier`, `high_paths`, `teammates` | the only account, `high`, `[]`, `[]` | Account the lead runs on; tier when nothing else decides; globs that make a PR high tier; GitHub logins whose approval is a teammate review |
| `[profile] max_workers`, `workers_per_account` | `0` (derived), `2` | Worker cap |
| `[profile.accounts] ID = VENDOR` | none | Each account and its agent CLI name (`claude`, `codex`, `gemini`, `qwen` or a custom `[agents.NAME]`), trimmed and compared case-insensitively. Declared, not verified |
| `[profile.agents] NAME = ID` | none | The account each agent (or GitHub login, in `github` mode) runs on. Names compare case-insensitively |

The profile must be written as `[profile]`, `[profile.accounts]` and `[profile.agents]` tables with plain keys: a dotted key (`accounts.a1 = ...`), an inline table (`accounts = { ... }`) or `profile...` keys outside those tables are config errors. An unknown key in `[profile]` is a config error (exit 2 from the commands that read the profile: `merge-gate`, `worker start`, `profile`; a `FAIL` row in `doctor`).
