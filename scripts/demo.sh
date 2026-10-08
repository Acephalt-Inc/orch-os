#!/bin/sh
# ORCH-os 5-minute demo. Offline; uses a throwaway ORCH_HOME so your real ~/.orch is untouched.
# Usage: sh scripts/demo.sh        (needs `orch` on PATH: `npm i -g .` or `sh install.sh` first)
# SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
set -u
ORCH_HOME=$(mktemp -d) || exit 1   # always a fresh dir; an inherited ORCH_HOME is ignored
export ORCH_HOME
REPO=$(mktemp -d) || exit 1
trap 'rm -rf "$ORCH_HOME" "$REPO"' EXIT
step() { printf '\n$ %s\n' "$*"; "$@"; rc=$?; [ $rc -ne 0 ] && printf '(exit=%s)\n' "$rc"; return 0; }

echo "# 1. install check + config + handbook"
step orch --version
step orch init
step orch doctor

echo; echo "# 2. the lease: one lead at a time"
step orch lease acquire --session lead-A
step orch lease acquire --session lead-B
step orch lease release --session lead-A
step orch lease acquire --session lead-B

echo; echo "# 3. task claims: one holder per task"
step orch task claim parser-fix --as w1
step orch task claim parser-fix --as w2
step orch task list

echo; echo "# 4. addressed messages: question, answer, done"
step orch msg send QUESTION --as w1 --to lead -m "Keep the old --legacy flag?"
Q=$(orch msg read --as lead --json | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)
step orch msg read --as lead --ack
step orch msg send ANSWER --as lead --to w1 --reply-to "$Q" -m "Yes, keep it one more release."
step orch msg watch --as w1 --count 1 --timeout 5 --ack
step orch msg send DONE --as w1 --to lead -m "parser fixed; 12/12 tests pass"
step orch task release parser-fix --as w1

echo; echo "# 5. the merge gate (recorded PR states, no GitHub needed)"
step orch merge-gate 101 --fixture approved
step orch merge-gate 101 --fixture stale-approval
step orch merge-gate 101 --fixture self-approval
step orch merge-gate 101 --fixture approved --head 0000000

echo; echo "# 6. workers: readiness first, then a worker in its own worktree"
git -C "$REPO" init -q && git -C "$REPO" -c user.name=demo -c user.email=demo commit -q --allow-empty -m init
step orch load
echo; echo "(every worker start without --force runs the readiness checks; this fresh home has no"
echo " reviewer, no [merge] repo and no verifiable agent login, so the start is refused)"
step orch worker start w1 --workdir "$REPO" --worktree -- sh -c 'echo worker {name} in $(basename "$PWD"); sleep 60'
if [ -t 0 ]; then
  echo; echo "(attended override: --force needs a terminal on stdin and prints a warning)"
  step orch worker start w1 --workdir "$REPO" --worktree --force -- sh -c 'echo worker {name} in $(basename "$PWD"); sleep 60'
  sleep 1
  step orch worker list
  step cat "$ORCH_HOME/workers/w1/stdout.log"
  step orch worker stop w1
else
  echo; echo "(stdin is not a terminal: skipping the attended --force worker)"
fi

echo; echo "# 7. notes that outlive the session"
step orch mem add poll-often -t rule -d "Check messages every minute"
step orch mem add poll-less -t rule -d "Check messages every five minutes; use msg watch"
step orch mem retire poll-often --superseded-by poll-less
step orch mem search messages --all
step cat "$ORCH_HOME/mem/INDEX.md"
