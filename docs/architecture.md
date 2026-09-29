# Architecture

## Shape

ORCH-os is one TypeScript package (`orch-os`, compiled with `tsc` to `dist/`, Node.js ≥ 20) behind one command, `orch`. Every invocation is a short-lived process: load the config, take a lock where needed, change one file atomically, print a result, exit with a meaningful code. There is no daemon, socket or database. Shared state is a handful of plain files under `$ORCH_HOME` (default `~/.orch`) that any agent, script or human can inspect.

```text
                 agents / terminals / cron
                           │   (each call = one process)
                           ▼
 ┌──────────────────────────── orch (cli.ts, args.ts) ────────────────────────────┐
 │ init/doctor  lease   msg          task      mailbox   merge-gate  worker   load   mem │
 │ config.ts    lease.ts messages.ts tasks.ts  mailbox.ts mergegate.ts workers.ts load.ts mem.ts │
 │ detect.ts    └──────────── lock.ts (mkdir lock) ────────────┘                    handbook.ts │
 └────┬──────────┬──────────┬───────────┬──────────┬─────────┬──────────┬───────┬──────┘
      ▼          ▼          ▼           ▼          ▼         ▼          ▼       ▼
 config.toml lease.json messages.jsonl tasks/   mailbox.md  gh CLI   workers/ load.json mem/
 handbook/              cursors/       ID.json              (GitHub) worktrees/        INDEX.md
```

## Modules

| Module | Responsibility | State |
|---|---|---|
| `cli.ts` | One `cmd*` function per subcommand, exit codes, error mapping; everything after `--` in `worker start` is kept verbatim | none |
| `args.ts` | argparse-style parsing: nested subcommands, typed options, `--opt=value`, `-n5`, `--`, `-h` | none |
| `config.ts`, `toml.ts` | Default config template, `ORCH_HOME` resolution, TOML reading; `replaceTables()` swaps whole tables in the text and keeps every other byte | `config.toml` |
| `profile.ts` | The `[profile]` tables: validation, degrade rules, the pure `policy()` table, grading of approvals, tier choice, doctor rows, rendering the tables | `config.toml` (`[profile]` tables, through `toml.ts`) |
| `detect.ts` | Known agent CLIs and headless command templates; PATH plus fallback-dir search (`ORCH_AGENT_DIRS`) | none |
| `lock.ts` | The cross-process lock (below) | `<file>.lock.d/` |
| `lease.ts` | status / acquire / renew / release under the lock; epoch fencing; read-back | `lease.json` |
| `tasks.ts` | One `Lease` per task id; no force; `CLAIMED` status names | `tasks/ID.json` |
| `messages.ts` | Append-only JSON-lines log, seq under the lock, per-reader cursors and acks | `messages.jsonl`, `cursors/NAME.json` |
| `mailbox.ts` | Sectioned Markdown mailbox; locked insert-at-top; parsing and reading | `mailbox.md` |
| `reviewwatch.ts` | `review watch`: CI rows of the head commit, the pure `chooseReviewer()` (author exclusion, strength grading, profile policy), one dispatch per head through `workers.ts`, the posted-line check, doctor rows | `review-watch/OWNER__NAME__PR.json`, `review-watch/*.prompt.md` |
| `mergegate.ts` | Review evaluation against the head commit, CI and label rules, shape validation, `gh pr view` fetch, fixtures | none (reads GitHub or a fixture) |
| `workers.ts` | Detached `spawn` in a new session, `timeout`/`nice` wrapping, per-worker directory, process-group stop, worktrees | `workers/NAME/`, `worktrees/NAME/` |
| `load.ts` | Portable sampling, tier state machine with hysteresis, optional renice | `load.json` |
| `schedule.ts` | `orch schedule install/status/remove`: launchd/systemd-user/cron unit rendering and install, behind an injectable host so the OS calls are never made in tests | `~/Library/LaunchAgents/*.plist`, `~/.config/systemd/user/*`, or a crontab block |
| `mem.ts` | One file per entry, frontmatter, generated capped index, retire | `mem/*.md`, `mem/INDEX.md` |
| `handbook.ts` | Writes `templates/handbook/*` to the target dir (flat or skills layout) | `handbook/` |
| `pyjson.ts` | JSON text in the exact layout v1.1 wrote | none |

## The lock

Node.js has no `flock`, so v2 uses an **atomic `mkdir`** lock. Every locked file has a sibling lock directory, `<file>.lock.d` (the notes store uses `mem/.lock.d`).

| Step | What happens |
|---|---|
| Acquire | `mkdir <file>.lock.d` succeeds for exactly one process (the kernel makes `mkdir` atomic). The winner writes `owner.json` = `{pid, host, token, created_ms}` into it. |
| Wait | Everyone else retries with a jittered backoff (1 ms doubling to 25 ms) until it wins or the timeout passes (30 s, then `LockTimeoutError`, exit 2 from the CLI). |
| Recovery | A lock left behind by a holder that died is removed by the next caller. |
| Release | The holder removes the lock only if `owner.json` still carries its token; otherwise it raises `LockLostError` (exit 5 from the CLI: the result is not verified). |

Differences from v1.1's `flock`: a crashed holder's lock is removed by the next caller instead of being dropped by the kernel (callers that arrive before that may time out with exit 2); waiting has a timeout instead of blocking forever; the lock works the same on local disks and on network filesystems where `mkdir` is atomic. The v1.1 `.lock` files are not used and can be deleted. Do not run v1.1 and v2 against the same `ORCH_HOME` at the same time: `flock` and `mkdir` locks do not exclude each other.

## Concurrency and durability

- **Re-read under the lock.** Every read-modify-write re-reads its data file inside the lock.
- **Atomic writes.** New contents go to a temporary file in the same directory, then `rename` swaps it in. The lease and task files are also `fsync`ed and set to mode 0600.
- **Read-back.** A lease or claim is reported only after the stored file, read back under the same lock, shows the caller as holder (exit 5 otherwise).
- **Messages** are appended as one line in one `write` while the lock is held; a reader that ever sees a torn line skips it and picks it up on the next read.
- **Contention tests.** 10 processes posting 40 mailbox entries, 6 processes doing 150 locked increments, 6 processes sending 30 messages (seqs 1..30 with no gap), and 8 processes racing for one task claim (exactly one winner).

## File formats

`lease.json`, `tasks/ID.json`, `load.json`, `workers/NAME/worker.json` and `mailbox.md` use the fields, key order and text layout v1.1 wrote (`pyjson.ts` reproduces Python's `json.dumps` separators and escaping). Two differences remain: a float that happens to be whole is written as `1700000000` where Python wrote `1700000000.0`, and JSON objects with integer-like keys list those keys first. Both read back the same. A v1.1 state directory is read by v2 as is; see [migration.md](migration.md).

## Worker process model

```text
orch worker start w1 --agent <name> --worktree --task task.md
  ├─ git worktree add -b orch/w1 <worktree_root>/w1 HEAD      (or attach an existing one)
  └─ spawn(detached: new session, stdin=task.md, stdout/stderr → workers/w1/*.log, cwd=worktree)
       └─ nice -n 5 timeout 3600 /abs/path/to/agent <headless flags>
            └─ (whatever the agent starts: shells, tests, servers)
orch worker stop w1  →  kill(-pgid, SIGTERM) → wait 5 s → kill(-pgid, SIGKILL)
                     →  git status --porcelain empty? → git worktree remove (branch kept)
```

The absolute agent path in the config means a worker started from cron, with its minimal PATH, still finds its binary.

## Merge-gate data flow

`merge-gate` fetches `author, headRefOid, reviews, labels, statusCheckRollup` with one `gh pr view --json` call, or loads the same JSON from a fixture. `evaluate()` is a pure function of that JSON and the settings, so it is fully testable offline. It validates the shape of what it reads: a wrong type anywhere (a string where a list belongs, a number for a head) throws, and the CLI prints `BLOCKED (unreadable PR data: ...)`. Any fetch error prints `BLOCKED` and exits 1.

With `--reviews comments` the field list gains `comments`, and the CLI first reads the author agents of `--task ID` from the task store; `evaluate()` then takes approvals and blocks from `ORCH-REVIEW` review comments instead of GitHub reviews. `orch review` is the only command that writes to GitHub: one `gh pr comment` per call.

With a `[profile]` table, `evaluate()` still decides first. The CLI then calls the pure `gateProfile()` in `profile.ts` with the approvals that counted, the author agents, the GitHub approvals at the head (for teammates) and, when `high_paths` is set, the changed files (`files,changedFiles,number` join the field list only then, and the full list comes from the paginated `gh api .../pulls/N/files`; a list whose length is not `changedFiles` reads as unreadable, so the tier is `high`). It returns the tier, the achieved and needed review strength, the teammate state, the merge authority, and its own pass/fail; the combined `ok` decides the exit code, and `render()` inserts the strength line. Without a `[profile]` none of this runs, so the output is unchanged byte for byte (`tests/snapshots/merge-gate-pre-profiles.json`).

## Review-watch data flow

`review watch` reads through a small host interface (`pr`, `checks`, `which`, `dispatch`, `now`, `sleep`), so every decision is testable with a fake host. It reads the PR (`gh pr view --json headRefOid,state,comments`), then the check runs and status contexts of the head commit (`gh api .../commits/SHA/check-runs` and `.../status`). `ciAtHead()` keeps only rows whose sha is the head, so a green older commit never counts. `chooseReviewer()` is pure: it drops the task's holders, grades the rest against them with the same account and vendor data as `profile.ts`, and applies `policy()` for the tier. The dispatch and the state write happen under the lock of the PR's state file, after a re-read, so two watchers never start two reviewers for one head. The reviewer is an ordinary worker (`Workers.start` with an extra environment), so `orch worker list|stop` see it. Nothing here writes to GitHub: the reviewer posts its own review comment.

## Dependencies

**Runtime: none.** The published package depends only on Node.js built-ins (`fs`, `child_process`, `os`, `path`, `crypto`, `url`). The pieces a library would usually provide are small and local:

| Need | Solution | Why not a package |
|---|---|---|
| TOML config | `toml.ts`, a reader for the subset `config.toml` uses; unsupported syntax is an error, never a guess | The config is ours and small; a parser dependency would be the largest code in the install |
| Argument parsing | `args.ts` | argparse-compatible behaviour (exit 2, error text) was needed anyway |
| File locking | `lock.ts` | Lock libraries add their own staleness rules; ours is small and tested |

**Development only** (not installed for users): `typescript` (compiler), `@types/node` (type definitions), `vitest` (test runner). All three are widely used, maintained projects, pinned by major version in `package.json`.

## Configuration

All deployment-specific values live in `config.toml`. Read-only commands work before `init` because missing config falls back to the rendered defaults, and a v1.1 config without the new tables gets defaults for them. A malformed file gives a one-line error and exit 2.

`config.toml` is written in three places only: `init` (the whole file), and `profile update` / `init --force` for the profile tables. `profile update` never re-renders the file: `replaceTables()` locates the `[profile*]` table headers with the same parser that reads the config, cuts each table from its header to the next header (leaving comments just above a non-profile header in place), and puts the new tables where the first one was. The result is read back and compared, table by table, before it replaces the file.

## Left out on purpose

- **The agent loop.** Tools, permissions, context and sessions belong to the agent CLI.
- **A scheduler.** Run `orch load`, `orch msg watch` or periodic checks from cron, systemd timers or any other scheduler.
- **Merging.** `merge-gate` only answers whether a merge is allowed.
- **Network services.** Nothing listens on a port. Only live `merge-gate` calls out, through `gh`.
- **Windows.** Workers rely on POSIX process groups and signals.
