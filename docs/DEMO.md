# ORCH-os — 5-minute demo

Everything below runs **offline**: no GitHub credentials, no model API keys, and no changes to your real `~/.orch`. The script uses a throwaway `ORCH_HOME` and a throwaway git repository.

## Run it

```sh
npm install && npm run build && npm i -g .     # or: sh install.sh && export PATH="$HOME/.local/bin:$PATH"
sh scripts/demo.sh
```

## What each step shows

1. **Install, doctor, handbook.** `orch init` writes the config, the mailbox and the four handbook files. `orch doctor` reports PASS/FAIL per prerequisite; optional tools show as SKIP and never fail it.
2. **Lease.** Session B cannot take the lead role while A holds an unexpired lease (exit 3, `BUSY`). After A releases, B acquires it and the epoch goes from 1 to 2, which fences off any late renewal from A.
3. **Task claims.** w1 claims `parser-fix`; w2's claim of the same task is refused with `BUSY`.
4. **Messages.** w1 asks the lead a `QUESTION`; the lead reads and acks it, and sends an `ANSWER` that names the question. `msg watch` on w1's side prints the answer as soon as it arrives. w1 reports `DONE` and releases the task.
5. **Merge gate.** Recorded PRs: an approval of the head commit (`PASS`), an approval of an older commit (stale, `BLOCKED`), the author approving their own PR (`BLOCKED`), and an expected-head guard that no longer matches (`head moved`).
6. **Readiness, workers and worktrees.** Every `orch worker start` without `--force` runs the readiness checks first. The throwaway home has no reviewer, no `[merge] repo`, no `origin` and no verifiable agent login, so the first start is refused (exit 2) and names each failing or `UNVERIFIED` check. When the script runs in a terminal, it then repeats the start with `--force`, the attended override, which prints a warning: the detached worker runs in its own git worktree on branch `orch/w1`, and stopping it stops its process group and removes the worktree because it is clean (the branch stays). When stdin is not a terminal, `--force` would be refused, so the script prints `(stdin is not a terminal: skipping the attended --force worker)` instead of that part.
7. **Notes.** Two rules, the older one retired in favour of the newer one: the file stays and `search --all` shows the link, while `INDEX.md` lists only the active rule.

Live mode for step 5, with `gh` and a repo: `orch merge-gate <pr> --repo owner/name`.

## Expected output

Recorded in a throwaway HOME with only `/usr/bin:/bin` and `node` on PATH, so no agent CLI, `gh` or `timeout` was visible and those rows show `SKIP`. Placeholders replace values that change between runs: `$ORCH_HOME`, `$REPO`, `<id>`, `<timestamp>`, `<pid>`, `<n>`, `<version>`, `<platform>`, `<~3600>`, `<~7200>`.

```text
# 1. install check + config + handbook

$ orch --version
orch 2.0.1

$ orch init
agents: none of claude, codex, gemini, qwen found on PATH (workers still run any command given after --)
wrote $ORCH_HOME/config.toml
wrote $ORCH_HOME/mailbox.md
wrote $ORCH_HOME/handbook/lead-boot.md
wrote $ORCH_HOME/handbook/worker-boot.md
wrote $ORCH_HOME/handbook/review-boot.md
wrote $ORCH_HOME/handbook/protocols.md
boot: point each agent session at its role file, e.g. $ORCH_HOME/handbook/lead-boot.md (see docs/faq.md)
next: orch doctor

$ orch doctor
PASS  node>=22                     <version>
PASS  posix (process groups)       <platform>
PASS  config                       $ORCH_HOME/config.toml
PASS  state dir writable           $ORCH_HOME
PASS  lease lockable               $ORCH_HOME/lease.json (FREE)
PASS  mailbox                      $ORCH_HOME/mailbox.md
PASS  mailbox sections             LEAD,WORKER,REVIEWER,SYSTEM
PASS  messages                     $ORCH_HOME/messages.jsonl
PASS  task registry                $ORCH_HOME/tasks
PASS  mem                          $ORCH_HOME/mem (0/200 index lines)
PASS  handbook                     $ORCH_HOME/handbook
PASS  git                          /usr/bin/git
SKIP  gh (merge-gate live mode)    absent - fixtures still work
SKIP  merge repo                   unset - pass --repo or use --fixture
SKIP  worker command               none configured - use --agent or pass a command after --
SKIP  timeout (worker time limit)  absent - worker start is refused without it (attended --force runs with no time limit)
SKIP  agent CLIs                   none found (install one, then `orch init --force`)
PASS  load state                   no sample yet (run `orch load`)
doctor: PASS (0 required check(s) failed)

# 2. the lease: one lead at a time

$ orch lease acquire --session lead-A
lease ACQUIRED holder=lead-A epoch=1 expires_in=<~3600>s

$ orch lease acquire --session lead-B
lease BUSY holder=lead-A epoch=1 expires_in=<~3600>s
(exit=3)

$ orch lease release --session lead-A
lease RELEASED holder=lead-A epoch=1 expires_in=0s

$ orch lease acquire --session lead-B
lease ACQUIRED holder=lead-B epoch=2 expires_in=<~3600>s

# 3. task claims: one holder per task

$ orch task claim parser-fix --as w1
task parser-fix CLAIMED holder=w1 epoch=1 expires_in=<~7200>s

$ orch task claim parser-fix --as w2
task parser-fix BUSY holder=w1 epoch=1 expires_in=<~7200>s
(exit=3)

$ orch task list
parser-fix               CLAIMED  holder=w1 epoch=1 expires_in=<~7200>s

# 4. addressed messages: question, answer, done

$ orch msg send QUESTION --as w1 --to lead -m Keep the old --legacy flag?
sent QUESTION <id> seq=1 to=lead

$ orch msg read --as lead --ack
--- #1 QUESTION from=w1 to=lead id=<id> <timestamp>
Keep the old --legacy flag?

$ orch msg send ANSWER --as lead --to w1 --reply-to <id> -m Yes, keep it one more release.
sent ANSWER <id> seq=2 to=w1

$ orch msg watch --as w1 --count 1 --timeout 5 --ack
--- #2 ANSWER from=lead to=w1 re=<id> id=<id> <timestamp>
Yes, keep it one more release.

$ orch msg send DONE --as w1 --to lead -m parser fixed; 12/12 tests pass
sent DONE <id> seq=3 to=lead

$ orch task release parser-fix --as w1
task parser-fix RELEASED holder=w1 epoch=1 expires_in=0s

# 5. the merge gate (recorded PR states, no GitHub needed)

$ orch merge-gate 101 --fixture approved
#101 head=4f2c9a1e7 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
=> PASS

$ orch merge-gate 101 --fixture stale-approval
#101 head=4f2c9a1e7 ci=green approvals=0/1 (stale=1 self=0) changes_requested=0 label=off
=> BLOCKED
(exit=1)

$ orch merge-gate 101 --fixture self-approval
#101 head=4f2c9a1e7 ci=green approvals=0/1 (stale=0 self=1) changes_requested=0 label=off
=> BLOCKED
(exit=1)

$ orch merge-gate 101 --fixture approved --head 0000000
#101 => BLOCKED (head moved: expected 0000000, PR is at 4f2c9a1e7)
(exit=1)

# 6. workers: readiness first, then a worker in its own worktree

$ orch load
load tier=NORMAL load_ratio=<n> swap=<n>% temp=n/a reniced=0

(every worker start without --force runs the readiness checks; this fresh home has no
 reviewer, no [merge] repo and no verifiable agent login, so the start is refused)

$ orch worker start w1 --workdir $REPO --worktree -- sh -c echo worker {name} in $(basename "$PWD"); sleep 60
worker: readiness failed: worker auth (UNVERIFIED: no login-status probe is known for 'sh'; only claude and codex can be verified, and wrappers are not parsed); reviewer selection (no reviewer configured: add a [review.agents.NAME] table with cmd (and vendor, account)); reviewer command (expected a non-empty argv array of strings; shell commands cannot be verified); reviewer auth (no verifiable executable); merge repo ([merge] repo must be a non-blank owner/name string); origin (git repository has no origin); gh (gh not on PATH); gh auth (gh auth status failed or could not run); timeout (timeout/gtimeout missing or unusable)
(exit=2)

(attended override: --force needs a terminal on stdin and prints a warning)

$ orch worker start w1 --workdir $REPO --worktree --force -- sh -c echo worker {name} in $(basename "$PWD"); sleep 60
WARNING: attended --force bypasses readiness and load admission
worker w1 started pid=<pid> load=NORMAL dir=$ORCH_HOME/workers/w1
worktree $ORCH_HOME/worktrees/w1 branch=orch/w1 (created)

$ orch worker list
w1                   RUNNING  pid=<pid>

$ cat $ORCH_HOME/workers/w1/stdout.log
worker w1 in w1

$ orch worker stop w1
worker w1 TERMINATED pid=<pid>
worktree removed $ORCH_HOME/worktrees/w1 (branch orch/w1 kept)

# 7. notes that outlive the session

$ orch mem add poll-often -t rule -d Check messages every minute
added poll-often (rule) $ORCH_HOME/mem/poll-often.md; index 1/200 lines

$ orch mem add poll-less -t rule -d Check messages every five minutes; use msg watch
added poll-less (rule) $ORCH_HOME/mem/poll-less.md; index 2/200 lines

$ orch mem retire poll-often --superseded-by poll-less
retired poll-often (superseded by poll-less); file kept: $ORCH_HOME/mem/poll-often.md

$ orch mem search messages --all
poll-often               rule       Check messages every minute  [retired -> poll-less]
poll-less                rule       Check messages every five minutes; use msg watch

$ cat $ORCH_HOME/mem/INDEX.md
# Index

Generated by `orch mem`; do not edit by hand. One line per active entry.

- [poll-less](poll-less.md) (rule): Check messages every five minutes; use msg watch
```
