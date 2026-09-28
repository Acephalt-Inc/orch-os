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
orch merge-gate PR [--repo OWNER/NAME] [--head SHA] [--approvals N] [--label NAME] [--fixture NAME|PATH] [--json]
```

Prints the head, CI state, approvals (with stale and self counts), changes requested and label state, then `=> PASS` (exit 0) or `=> BLOCKED` (exit 1). Live mode runs `gh pr view PR --repo REPO --json author,headRefOid,reviews,labels,statusCheckRollup`; any error prints `BLOCKED (...)` and exits 1. `--head` makes the gate block with `head moved` when the PR is at a different commit.

| Fixture | Shows |
|---|---|
| `approved` | One non-author approval of the head commit, CI green: `PASS` |
| `stale-approval` | The only approval is for an older commit |
| `self-approval` | Only the PR author approved |
| `changes-requested` | One approval, but another reviewer requested changes |
| `ci-red` | A failing check |

## orch worker

```text
orch worker start NAME [--task FILE] [--workdir DIR] [--minutes M] [--agent A]
                       [--worktree [--branch B] [--base REF]] [--force] [-- CMD ...]
orch worker list
orch worker stop NAME [--keep-worktree]
```

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
| `[workers] root`, `command`, `timeout_minutes`, `nice`, `block_tiers` | `~/.orch/workers`, first detected agent, `60`, `5`, `HIGH CRITICAL` | Worker defaults |
| `[workers] worktree_root`, `worktree_branch_prefix` | `~/.orch/worktrees`, `orch/` | Where `--worktree` puts worktrees; default branch prefix |
| `[agents.NAME] command` | written by `init` | Command for `worker start --agent NAME` |
| `[load] state`, `busy`, `high`, `critical` | `~/.orch/load.json`; `load_ratio` 0.75 / 1.0 (+ `swap_pct` 90) / 1.5 | Tier thresholds (`load_ratio`, `swap_pct`, `temp_c`) |
| `[load] temp_command`, `renice_pattern`, `act` | `""`, `""`, `false` | Optional temperature probe; optional renice under HIGH/CRITICAL |
