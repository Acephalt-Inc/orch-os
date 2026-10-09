# Command reference

All commands read `$ORCH_HOME/config.toml` (default `~/.orch/config.toml`). Read-only commands use built-in defaults when the file does not exist yet. A malformed config gives exit 2 with a one-line message. Every command accepts `-h`/`--help`; a usage error exits 2.

| Environment variable | Effect |
|---|---|
| `ORCH_HOME` | State and config directory (default `~/.orch`) |
| `ORCH_AGENT` | Your name for `msg` and `task` when `--as` is not given |
| `ORCH_SESSION_ID` | Default `--session` for `lease`; second fallback for `--as` (then `user@host`) |
| `ORCH_AGENT_DIRS` | Colon-separated dirs searched for agent CLIs after PATH; empty string = PATH only |

Exit codes shared by all commands: `0` ok · `1` a "no" answer (`doctor` FAIL, `merge-gate` BLOCKED, `mem search` no hits) or an unexpected error · `2` usage, input or config error, including a lock that could not be taken within 30 s · `3` `BUSY` · `4` `NOT_HOLDER`, `EXPIRED`, `STALE_EPOCH` · `5` `UNVERIFIED` (read-back did not match, or the lock was lost).

## orch init

```text
orch init [--force] [--agent NAME] [--dir DIR] [--layout flat|skills] [--force-handbook] [--no-handbook]
          [--compute one|same-vendor|multi-vendor --people solo|team
           [--policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N] | --no-profile]
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
| `--compute V --people V --policy human-merge --required-review S --max-workers N` | Write a `[profile]` (see [orch profile](#orch-profile)) without asking. `--compute` and `--people` go together (either alone is exit 2), and the other three need them (exit 2 without). The policy, the review requirement and the worker limit have no default: when any of the three is missing, `init` writes no `[profile]` table and prints `no profile written from the flags: …` with the command that creates one. The detected agent CLIs fill `[profile.accounts]` (`acct1`, `acct2`, ...) as labels to edit |
| `--no-profile` | On a terminal, skip the two profile questions and write no `[profile]` |

**Profile questions.** When stdin is a terminal and `config.toml` is being written, `init` asks after detection: "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs?" (`1`/`2`/`3`, default `1`) and "Solo, or with teammates?" (`solo`/`team`, default `solo`). These two answers are declared context: they select no rule. It then asks three questions that have no default: whether to select the `human-merge` policy (`yes`/`no`), the weakest agent review that passes (`1`/`2`/`3` for `single-agent`/`cross-account`/`cross-vendor`), and the most workers running at once (a whole number, 1 or more). Three unusable answers to any question, `no` to the policy, or end of input write no profile, and `init` prints `no profile written: …` with the command that creates one. When stdin is not a terminal, `init` asks nothing and writes exactly the config it wrote before profiles existed. `--force` keeps an existing `[profile]` byte for byte (unless a complete set of the five profile flags replaces it). If the kept profile cannot be used, for example because it was written for the removed built-in table, `init --force` still keeps it byte for byte, prints the refusal with what to set on stderr, does not print `next: orch doctor`, and exits 2. When `config.toml` exists and `--force` is not given, `--compute`/`--people` is exit 2 and the file is not touched: use `orch profile update`.

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
| profile rows (only when `config.toml` has a `[profile]` table) | `profile` FAIL when the table is invalid or was written for the removed built-in table (no `policy` key); every other profile row is `PASS` or `SKIP` |

With a `[profile]`, doctor adds one row per profile check. A missing capability is a `SKIP` row that says what is off, for example `SKIP  profile accounts  same-vendor declared, but only one account is listed in [profile.accounts]; no review can grade above single-agent until a second account is added`. A missing capability never lowers the rule. The rows are `profile` (the selected policy, the declared compute and people, and the accounts), `profile accounts`, `profile vendors`, `profile vendor NAME` (a CLI found or an `[agents.NAME]` configured), `profile teammates`, `profile teammate reviews` (`gh` and `[merge] repo`), `profile reviewers` (only when `required_review` is above `single-agent`: agents on at least two accounts, or two vendors) and `profile agents` (`[agents.*]` names without an account in `[profile.agents]`). Without a `[profile]`, doctor prints the same rows as before.

## orch config

Prints the resolved configuration as JSON, with the file it came from.

## orch lease

```text
orch lease {status|acquire|renew|release} [--session ID] [--seconds N] [--expected-epoch N] [--force] [--json]
```

| Action | Result status |
|---|---|
| `status` | `HELD` or `FREE` |
| `acquire` | `ACQUIRED`; a new holder increments the epoch |
| `renew` | `RENEWED`; with `--expected-epoch`, refused (`STALE_EPOCH`) if the epoch moved |
| `release` | `RELEASED`; with `--expected-epoch`, refused if the epoch moved |

Output: `lease STATUS holder=... epoch=N expires_in=Ns`. `--force` takes over an unexpired lease and records `forced_takeover`. `--seconds` below `[lease] min_seconds` is raised to it.

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
orch task claim   ID [--as NAME] [--seconds N] [--json]
orch task renew   ID [--as NAME] [--seconds N] [--expected-epoch N] [--json]
orch task release ID [--as NAME] [--expected-epoch N] [--json]
orch task status  ID [--json]
orch task list       [--json]
```

Output: `task ID STATUS holder=... epoch=N expires_in=Ns`. Status and exit codes follow the lease: `CLAIMED` (0), `RENEWED` (0), `RELEASED` (0), `HELD`/`FREE` for `status`, `BUSY` (3), `NOT_HOLDER`/`EXPIRED`/`STALE_EPOCH` (4), `UNVERIFIED` (5). There is no `--force`. A task id is letters, digits, `_ . @ -`, not starting with a dot, and is case-insensitive (stored in lower case). `list` prints every task file as `CLAIMED`, `EXPIRED`, `RELEASED` or `FREE`.

## orch mailbox

```text
orch mailbox post SECTION [-m TEXT] [--author NAME]     # body from -m or stdin
orch mailbox read [-n N] [--section SECTION]
```

`post` prints the new entry id; an unknown section or empty body gives exit 2. Sections are case-insensitive. `read` prints the newest N entries (default 10), oldest first; control characters in timestamps and bodies are shown as `\xNN` (U+2028, U+2029, bidi marks, embeddings, overrides and isolates, and U+FEFF as `\uNNNN`).

## orch merge-gate

```text
orch merge-gate PR [--repo OWNER/NAME] [--head SHA] [--approvals N] [--label NAME] [--fixture NAME|PATH] [--reviews github|comments] [--task ID]
                   [--require-check NAME] [--tier low|high] [--auto] [--json]
```

Prints the head, CI state, approvals (with stale and self counts), changes requested and label state, then `=> PASS` (exit 0) or `=> BLOCKED` (exit 1). Live mode runs `gh pr view PR --repo REPO --json author,headRefOid,reviews,labels,statusCheckRollup`; any error prints `BLOCKED (...)` and exits 1. `--head` makes the gate block with `head moved` when the PR is at a different commit.

CI is green only when at least one check at the exact head concluded `SUCCESS`, no check failed or is unfinished, and every required check passed. `SKIPPED` and `NEUTRAL` are not passes: a rollup containing only those blocks. Without required checks, `SUCCESS` alongside `SKIPPED` or `NEUTRAL` retains the existing green result and output.

Set `[merge] required_checks = ["CI/test", "lint"]` to require specific checks in both `merge-gate` and `review watch`. Names compare exactly and case-sensitively: `name` matches the job or status-context name; `workflow/name` also matches that job in the named workflow. A literal status context called `CI/test` retains bare-name matching. Every matching row must conclude `SUCCESS`; missing checks (`ABSENT`), stale checks, `SKIPPED`, `NEUTRAL`, `CANCELLED`, pending checks and duplicate runs with conflicting conclusions block. The gate's JSON adds `required_checks` and `unmet_checks` when requirements are configured; text names unmet checks. Fixtures may include `headSha` or `head_sha`; those rows count only at the exact head. Live `statusCheckRollup` is already scoped to the PR head.

Repeat `--require-check NAME` to add requirements to the configured list for this gate invocation; it never replaces configured checks. Invalid lists or blank flag values exit 2. An absent or empty configured list means no required names.

`--reviews` picks where approvals come from (default `[review] source`, else `github`). Both sources apply the same CI rules. With `comments`:

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

**With a profile.** When `config.toml` has a `[profile]` table, the gate first applies every rule above, then labels the approvals it counted and applies the policy the profile selects (`human-merge`, see [orch profile](#orch-profile)). One line goes between the summary and the verdict:

```text
#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=human-merge tier=high(path: migrations/0042_add_index.sql) review=cross-account needed=cross-vendor teammate=n/a authority=owner
=> BLOCKED (review strength cross-account is below cross-vendor)
```

- **Tier**: `--tier` if given; else `high` when any changed file matches a `[profile] high_paths` glob (`*` and `?` stay inside one path segment, `**` crosses `/`); else `[profile] default_tier` (default `high`). A leading `/` in a glob is dropped (globs are relative to the repository root). Live mode adds `files,changedFiles,number` to the field list only when `high_paths` is not empty, then reads the full list with `gh api --paginate repos/OWNER/NAME/pulls/N/files` (`gh pr view` stops at 100 files). The list counts as read only when its length equals the PR's `changedFiles`; a fetch error, a missing count or a mismatch makes the tier `high`. A fixture needs `files` and a matching `changedFiles`. The line says where the tier came from: `flag`, `path: FILE`, `default` or `files unreadable`.
- **Review strength** is a label from the declared tables, not a measured quality. For each counted agent approval: `single-agent` (reviewer and author on one account), `cross-account` (different accounts, same vendor) or `cross-vendor`; `single-agent (unmapped)` when the reviewer or an author is not in `[profile.agents]`. With several authors (a hand-off), the weakest holds; across approvals, the strongest holds (`none` without one). The author is the PR author login (`github`) or every task holder (`comments`). A teammate's GitHub approval is not an agent approval.
- **Teammate**: `approved` when a login listed in `[profile] teammates` has an `APPROVED` GitHub review at the head (never the PR author), `missing`, or `n/a` in a solo profile. It is read from the `reviews` field in both review sources.
- **Passes** when the plain rule passes, the strength reaches `needed` (`[profile] required_review`), and a required teammate approval is there. The verdict names each failed condition. A pass says who performs the merge: `the owner decides the merge`, or `the teammate who approved, or the owner, performs the merge`.
- `--auto` means the caller would merge automatically on `PASS`. No policy gives that authority: with `--auto` the verdict is always `BLOCKED (--auto: policy human-merge gives no automatic merge authority; a person performs the merge)`, exit 1. `--json` adds one `profile` object: `policy, tier, tier_source, achieved, needed, teammate, need_teammate, authority, worker_cap, reasons`; existing keys keep their meaning, and `ok` is the combined verdict.
- A `[profile]` without a `policy` key was written for the built-in table an earlier source version carried: exit 2 with a message naming what to set, and no verdict ([profiles.md](profiles.md#6-migrating-a-profile-written-for-the-removed-built-in-table)).
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
require_ci = true      # false: allow no CI only when no required checks are configured
stale_minutes = 30     # a reviewer with no review line by then is STALE; also its worker time limit
poll_seconds = 60
```

The reviewer must be allowed to run `gh` and `orch`: add whatever permission flags your agent CLI needs to the command.

One pass:

1. `--task ID` names the PR's task: every agent that has held it is an author and is never chosen (the same rule as `merge-gate --reviews comments`). No `--task`, or a task with no holder: `BLOCKED`.
2. `gh pr view PR --json headRefOid,state,comments` gives the head. A closed or merged PR is `BLOCKED`.
3. If this head already has a reviewer (state file below), watch only follows it: `REVIEWED` once a comment whose first line is `ORCH-REVIEW <verdict> <head> by <that agent>` appears (a line for another commit does not count), `STALE` after `stale_minutes`, else `DISPATCHED`. It never starts a second reviewer for one head unless `--force`.
4. The reviewer: every `[review.agents.NAME]` that is not an author and whose command is on `PATH`, graded against the authors: `cross-vendor`, then `cross-account`, then `single-agent (fresh context)` (same account: a new session, labelled so), then `single-agent (unmapped)` (vendor or account not declared). The strongest wins; ties go to the first in `config.toml`. An agent's account is `account`, else its `[profile.agents]` entry; its vendor is the account's vendor in `[profile.accounts]`, else `vendor` (a contradiction is a config error). This order is a selection heuristic over declared labels; nothing verifies the accounts, and a label gives the reviewer no authority. With a `[profile]`, the needed strength is `[profile] required_review`, the same value `merge-gate` uses; a best reviewer below it is `BLOCKED` with the reason, never a weaker review. So `required_review = "single-agent"` gives a labelled single-agent review when only the author's account is available, and a higher value blocks.
5. CI uses the same evaluator and `[merge] required_checks` as the merge gate. Watch reads `gh api --paginate repos/OWNER/NAME/commits/SHA/check-runs`, `.../commits/SHA/status` and `.../actions/runs?head_sha=SHA&per_page=100`, joining check suites to workflow names and keeping only the exact head's rows. An unmet required check or a failed, unfinished or entirely skipped/neutral rollup is `WAITING`, with no dispatch, including under `--force`. An unlisted suite, a blank/conflicting workflow name or an unreadable workflow-run list leaves the check's workflow unknown. Such a row never supplies a qualified requirement; a same-name unknown row that did not pass also blocks an otherwise passing qualified requirement (`WORKFLOW_UNKNOWN`). A known required workflow's success plus an unknown same-name success can pass. This conservative rule may wait on another app's skipped/neutral check even while the gate has enough workflow information to pass. No check at all is `WAITING` unless `require_ci = false` and no required names are configured. This option never bypasses required checks.
6. Otherwise watch writes a prompt file and starts the reviewer as a worker named `review-PR-SHA12` (see `orch worker`: own process group, logs, time limit of `stale_minutes`, refused under a blocking load tier). The prompt is on its stdin and in `{prompt}`; the environment has `ORCH_AGENT`, `ORCH_REVIEW_PR`, `ORCH_REVIEW_HEAD`, `ORCH_REVIEW_REPO` and `ORCH_REVIEW_PROMPT`.

A new head means a new pass from step 3: a new reviewer once its CI is green. A reviewer still running for the old head is left alone; its line names the old sha and does not count.

```text
#7 head=4f2c9a1e7 ci=pending => WAITING (CI pending at the head: test=IN_PROGRESS)
#7 head=4f2c9a1e7 ci=green => DISPATCHED (started rx (cross-vendor) as worker review-7-4f2c9a1e7b3d)
#7 head=4f2c9a1e7 => REVIEWED (ORCH-REVIEW APPROVE 4f2c9a1e7b3d... by rx (cross-vendor))
```

Without `--once`, watch repeats every `--interval` seconds (default `poll_seconds`), printing a line when the status changes, until `REVIEWED` (exit 0), `STALE` or `BLOCKED` (exit 1), or `--timeout` (exit 1). `--once` makes one pass for cron: exit 0 for `WAITING`, `DISPATCHED` or `REVIEWED`, 1 for `BLOCKED`, `STALE` or a `gh` error. `--dry-run` makes one pass, prints the chosen reviewer and its command, and starts nothing and writes nothing. `--json` prints each result as JSON; its `choice.policy` key was `choice.cell` under the removed built-in table (see [orch profile](#orch-profile)). With a `[profile]`, a dispatch is refused while `[profile] max_workers` workers are already running: the result is `BLOCKED` and nothing is started. A bad PR number, a bad config value, or `--tier` without a `[profile]` exits 2.

State: one file per PR, `$ORCH_HOME/review-watch/OWNER__NAME__PR.json` (head, agent, label, worker, pid, time, status `dispatched|reviewed|stale`, earlier heads), written under the lock. `orch doctor` shows a `SKIP` row per reviewer command and per stale reviewer; with no `[review.agents]` and no state it shows nothing new.

Like the comments gate, this is a process gate between cooperating agents, not a security boundary: accounts and vendors are declared, not verified.

## orch worker

```text
orch worker start NAME [--task FILE] [--workdir DIR] [--minutes M] [--agent A]
                       [--worktree [--branch B] [--base REF]] [--force] [-- CMD ...]
orch worker list
orch worker stop NAME [--keep-worktree]
```

With a `[profile]`, `start` also refuses (exit 2) when the running workers already reach `[profile] max_workers`, the limit you wrote (see [orch profile](#orch-profile)). `--force` starts one anyway and prints `worker: warning: --force starts NAME above [profile] max_workers (…)` on stderr. The same limit applies when `review watch` starts a reviewer, and there it has no override. The count and the start are two steps, so two starts at the same instant can both pass. Without a profile there is no such limit.

`start` runs the worker detached and prints its pid, load tier and directory, plus a `worktree PATH branch=B (created|attached)` line with `--worktree`. It refuses (exit 2) when NAME is already running, the load tier blocks it (unless `--force`), the command is not on PATH, `--agent` is unknown, both `--agent` and `-- CMD` are given, or the worktree cannot be created (not a git repository, the branch is checked out elsewhere, the path exists but is not a worktree). `--minutes 0` disables the time limit.

With `--worktree`, `--workdir` names the repository (default: the current directory); the worker runs in `<[workers] worktree_root>/NAME` on branch `<worktree_branch_prefix>NAME` or `--branch`, created from `--base` (default `HEAD`). An existing worktree at that path is attached, not recreated.

`list` prints `RUNNING` (the worker, or members of its process group left after it exited, still run), `STOPPED` or `UNKNOWN` per worker. `start` also refuses while members of the previous run's group still run. `stop` signals the whole process group, including members left behind after the agent exited, and prints `TERMINATED` (the group exited after SIGTERM), `KILLED`, `NOT_RUNNING` or `PID_REUSED`, then what happened to the worktree: `worktree removed PATH (branch B kept)` when orch created it and it was clean, otherwise `worktree kept PATH (...)` with the reason (`dirty: N changed, M ignored path(s)`, `process group P still running` when a member survives SIGKILL, `attached, not created by orch`, `--keep-worktree`, or the git error). Branches are never deleted.

## orch load

```text
orch load [--read] [--json]
```

Takes one sample, advances the tier and prints `load tier=... load_ratio=... swap=...% temp=... reniced=N`. `--read` prints the stored state without sampling.

## orch schedule

```text
orch schedule install NAME --daily HH:MM --task FILE [--agent A] [--workdir DIR] [--dry-run]
orch schedule status [--json]
orch schedule remove NAME
orch schedule run NAME
```

`install` registers one daily current-user job. On macOS it writes `~/Library/LaunchAgents/com.orch-os.schedule.NAME.plist` and uses launchd. On Linux it writes `~/.config/systemd/user/orch-os-schedule-NAME.service` and `.timer` and uses the systemd user manager. `run` samples load and starts the recorded worker `sched-NAME`. The run starts only if `orch worker start` would start it at that moment; a refusal is one `REFUSED` line in the log. The agent runs with exactly the command in `[agents.NAME]`; what it may do with nobody present is decided by the flags you put there.

`status` reports `LOADED`, `MISSING`, `ORPHAN`, or `ERROR` from the record, unit files, executable paths, and scheduler manager. With no records or unit files it prints `no scheduled jobs`.

The command refuses an invalid name, a daily time outside `00:00` through `23:59`, a missing or non-regular task, a missing workdir, an unavailable agent command, a foreign or symbolic-link unit file, and Linux without an answering systemd user manager. The refusal sentence for an unsupported platform is `schedule: no scheduler backend for PLATFORM in this version; nothing was installed or changed`. Windows is refused rather than using Task Scheduler because worker process handling is POSIX-only and Task Scheduler could only be tested here against stand-ins. No backend uses sudo or crontab.

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
orch profile update [--policy human-merge] [--required-review single-agent|cross-account|cross-vendor] [--compute V] [--people V]
                    [--account ID=VENDOR]... [--remove-account ID]... [--agent NAME=ID]... [--remove-agent NAME]...
                    [--teammate LOGIN]... [--remove-teammate LOGIN]... [--high-path GLOB]... [--remove-high-path GLOB]...
                    [--default-tier low|high] [--lead-account ID] [--max-workers N] [--dry-run]
```

A profile holds declared review context and one selected policy. The context is **compute** (`one` account, several accounts on the `same-vendor` agent CLI, or `multi-vendor`), **people** (`solo`, or a `team` whose teammates approve on GitHub), and the `[profile.accounts]` and `[profile.agents]` labels. All of it is declared, not verified. The details and the limits are in [profiles.md](profiles.md).

The public example policy is `human-merge`, selected with `policy = "human-merge"`:

| Rule | Value |
|---|---|
| A non-author agent review at the PR's head, labelled at or above | `[profile] required_review` (both tiers) |
| A listed teammate's GitHub approval at the head | needed for a `high`-tier PR in a `team` profile |
| Who performs the merge | a person, always; `merge-gate --auto` is always `BLOCKED` |
| Limit on running workers | `[profile] max_workers` (an integer ≥ 1), checked at `worker start` and at a `review watch` dispatch; `worker start --force` overrides it with a warning |

Nothing is derived from the number of accounts or vendors. A review strength the setup cannot give is `BLOCKED` and reported as a missing capability; the rule is not lowered. A `team` with no teammates listed blocks every high-tier PR.

**A profile written for the removed built-in table.** A `[profile]` with no `policy` key may come from the removed built-in table or may have been written by hand. `merge-gate`, `review watch`, `worker start` and `profile show` exit 2 with a message naming what to set, and `profile update` writes nothing until the policy is selected: `orch profile update --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N`. Choose each value yourself. `--max-workers` also removes a `workers_per_account` key, which is no longer supported.

`show` prints the selected policy with the declared compute and people, the accounts, agents, teammates, tier settings, the rule for `low` and `high`, and each missing capability. `--json` prints `policy, compute, people, lead_account, required_review, default_tier, high_paths, teammates, accounts, agents, max_workers, rules, missing`. Without a `[profile]` it prints `profile: not set (merge gate uses the plain rule)` and exits 0; `--json` prints `{"profile": null}`.

**`--json` keys changed with the removal of the built-in table (a wire compatibility change).** `merge-gate --json`: the `profile` object loses `cell`, `declared_cell` and `degraded` and gains `policy` (the policy name); `authority` is never `auto`. `profile show --json`: `cell`, `declared_cell`, `effective_compute`, `workers_per_account` and `degraded` are gone; `policy` was an object with a rule per tier and is now the policy name, the per-tier rules are under the new key `rules`, and `required_review` is added. `review watch --json`: `choice.cell` is now `choice.policy` (the policy name, or `null` without a `[profile]`). The table and a before/after example are in [docs/profiles.md](profiles.md), section 6.

`update` changes only the `[profile]`, `[profile.accounts]` and `[profile.agents]` tables. The new tables replace the old ones in place (appended after one blank line when there were none); comments and blank lines just above the next table stay, and every other byte of `config.toml` is kept. The new tables use the file's line endings (CRLF when its first line ends in CRLF). The result is validated and read back before it is written: a bad value, or a profile that is not written as plain tables, is exit 2 with nothing written. Creating a profile needs `--compute`, `--people`, `--policy`, `--required-review` and `--max-workers`: no value is filled in for you, and a missing one is exit 2 with nothing written. Removing something that is not there is exit 2. `--dry-run` prints the new tables instead.

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
| `[merge] repo`, `required_approvals`, `required_label`, `required_checks` | `""`, `1`, `""`, `[]` | Live-mode repo; approvals needed at the head; optional label; exact required names shared with review watch |
| `[review] source` | `github` | Where `merge-gate` approvals come from: `github` reviews, or `comments` (ORCH-REVIEW comments; needs `--task`) |
| `[review.agents.NAME] cmd`, `vendor`, `account` | none | A reviewer for `review watch`: argv or shell command line; declared vendor and account (the account's vendor in `[profile.accounts]` wins) |
| `[review.watch] require_ci`, `stale_minutes`, `poll_seconds`, `dir` | `true`, `30`, `60`, `~/.orch/review-watch` | `false` = no CI expected; when a silent reviewer is stale; loop interval; state files |
| `[workers] root`, `command`, `timeout_minutes`, `nice`, `block_tiers` | `~/.orch/workers`, first detected agent, `60`, `5`, `HIGH CRITICAL` | Worker defaults. The numbers are example values to tune for your machine |
| `[workers] worktree_root`, `worktree_branch_prefix` | `~/.orch/worktrees`, `orch/` | Where `--worktree` puts worktrees; default branch prefix |
| `[agents.NAME] command` | written by `init` | Command for `worker start --agent NAME` |
| `[load] state`, `busy`, `high`, `critical` | `~/.orch/load.json`; `load_ratio` 0.75 / 1.0 (+ `swap_pct` 90) / 1.5 | Tier thresholds (`load_ratio`, `swap_pct`, `temp_c`). Example values to tune for your machine, not limits that suit every machine |
| `[load] temp_command`, `renice_pattern`, `act` | `""`, `""`, `false` | Optional temperature probe; optional renice under HIGH/CRITICAL |
| `[profile] policy`, `required_review` | none (required in a `[profile]`) | `human-merge`; `single-agent` / `cross-account` / `cross-vendor`. A `[profile]` without `policy` is refused |
| `[profile] compute`, `people` | none (required in a `[profile]`) | Declared context: `one` / `same-vendor` / `multi-vendor`; `solo` / `team`. No `[profile]` table = no profile |
| `[profile] lead_account`, `default_tier`, `high_paths`, `teammates` | the only account, `high`, `[]`, `[]` | Account the lead runs on; tier when nothing else decides; globs that make a PR high tier; GitHub logins whose approval is a teammate review |
| `[profile] max_workers` | none (required in a `[profile]`) | Most workers running at once: an integer ≥ 1 that you choose. It is not derived from the accounts |
| `[profile.accounts] ID = VENDOR` | none | Each account and its agent CLI name (`claude`, `codex`, `gemini`, `qwen` or a custom `[agents.NAME]`), trimmed and compared case-insensitively. Declared, not verified |
| `[profile.agents] NAME = ID` | none | The account each agent (or GitHub login, in `github` mode) runs on. Names compare case-insensitively |

The profile must be written as `[profile]`, `[profile.accounts]` and `[profile.agents]` tables with plain keys: a dotted key (`accounts.a1 = ...`), an inline table (`accounts = { ... }`) or `profile...` keys outside those tables are config errors. An unknown key in `[profile]` is a config error (exit 2 from the commands that read the profile: `merge-gate`, `worker start`, `profile`; a `FAIL` row in `doctor`).
