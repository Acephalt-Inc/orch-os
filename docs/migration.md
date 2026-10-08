# Moving from v1.1 (Python) to v2 (TypeScript)

v2 is a rewrite of the same tool in TypeScript for Node.js ≥ 22. The five v1.1 building blocks (lease, mailbox, merge gate, workers, load governor), the CLI and the doctor behave the same: same commands and flags, same output lines, same exit codes, same status and error names (`BUSY`, `NOT_HOLDER`, `EXPIRED`, `STALE_EPOCH`, `UNVERIFIED`, `PID_REUSED`, `head moved`), compatible file formats and the same fail-closed defaults. Every v1.1 test has a v2 counterpart ([tests-map.md](tests-map.md)).

## Steps

1. Stop anything that runs v1.1 against your `ORCH_HOME`: cron jobs, running workers (`orch worker stop NAME` with v1.1), sessions holding the lease.
2. Remove the Python install: `pipx uninstall orch-os`, or delete `~/.orch/lib` and the old launcher in `~/.local/bin/orch`.
3. Install v2: `npm i -g orch-os`, or `sh install.sh` from a clone.
4. Run `orch init`. Your existing `config.toml` is kept; the command adds the handbook. Run `orch doctor`.
5. Optional: copy the new tables (`[messages]`, `[tasks]`, `[mem]`, `[handbook]`, and the two `worktree_*` keys in `[workers]`) from `orch init --force` output into your config if you want to change their defaults. Without them the defaults apply.
6. Optional: delete the leftover `lease.json.lock` and `mailbox.md.lock` files.

## What changes

| Area | v1.1 | v2 |
|---|---|---|
| Runtime | Python ≥ 3.11, standard library only | Node.js ≥ 22, no runtime dependencies |
| Install | `pipx install`, `install.sh` | `npx orch-os init`, `npm i -g orch-os`, `install.sh` |
| Lock | `fcntl.flock` on `<file>.lock` | atomic `mkdir` of `<file>.lock.d`, with stale-lock breaking and a 30 s timeout ([architecture.md](architecture.md#the-lock)) |
| Lock wait | blocks until free | gives up after 30 s: exit 2 |
| `lease release` | no epoch check | optional `--expected-epoch` |
| `doctor` rows | `python>=3.11`, `posix (flock, process groups)` | `node>=22`, `posix (process groups)`, plus `messages`, `task registry`, `mem`, `handbook` |
| `worker start` | runs in `--workdir` | also `--worktree`, `--branch`, `--base` |
| `worker stop` | stops the process group | also removes a clean worktree it created; `--keep-worktree` |
| `init` | config, mailbox | also the handbook: `--dir`, `--layout`, `--force-handbook`, `--no-handbook` |
| New commands | none | `orch msg`, `orch task`, `orch mem` |
| Abbreviated flags | argparse accepted unique prefixes (`--sess`) | full flag names only; a prefix is a usage error (exit 2) |
| Unexpected errors | Python traceback, exit 1 | one error message with a stack trace, exit 1 |
| Config values | a non-numeric duration crashed | a non-numeric duration, limit or `nice` (numbers or numeric strings are accepted), or an invalid `renice_pattern`, is a config error: exit 2; `doctor` shows a bad `[messages]`, `[tasks]`, `[mem]` or `[workers]` value as a FAIL row |
| `worker stop` | returned once the agent itself exited | waits for the whole process group; members that ignore SIGTERM or outlive the agent get SIGKILL; a worktree with ignored files is kept |
| Control characters | printed as they are | `mailbox read` and `msg` output show them as `\xNN` |

## Compatibility of state files

`lease.json`, `load.json`, `mailbox.md` and `workers/NAME/worker.json` keep the v1.1 fields and layout, so v2 reads a v1.1 state directory as is, and a lease held under v1.1 stays held. (A whole-number float is written without `.0`; it reads back the same.)

**Do not run v1.1 and v2 against the same `ORCH_HOME` at the same time.** v1.1 locks with `flock` on `<file>.lock` and v2 with `mkdir` on `<file>.lock.d`; the two do not exclude each other, so a v1.1 and a v2 process could both change the lease at once. Switch every session and scheduler over in one go.

## Nothing to migrate for the new features

Messages, task claims, notes and the handbook are new in v2 and start empty. If you kept long-lived notes elsewhere, add them with `orch mem add NAME -d "one line" -t TYPE < note.md`.
