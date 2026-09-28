---
name: serial-merge
description: Use when merging PRs that have passed review ("merge what's ready", "why isn't anything merging?"), on /serial-merge, and before any merge done without a human watching. Merges one PR at a time, only when `orch merge-gate` passes for the current head commit, reads the result back, and re-checks every remaining PR before the next merge. Never batches.
---

# /serial-merge — one PR, re-check, next PR

**Merge one, re-check, merge the next. Never batch.** Every merge changes the base
that every other open PR was tested against. A PR that was mergeable a minute ago can
now conflict, or merge cleanly and break.

## Who may merge

This skill does not grant merge authority. Use it only when the human has said that
merges may happen: a standing "merge whatever passes the gate", or a one-off "merge
#N once it passes review". A one-off covers only the PR it names.

## The gate: one command

```sh
orch merge-gate <PR> --head <sha-you-reviewed>
```

Merge only on a pass. The gate already requires green CI, the configured number of
approvals from someone other than the author **for the current head commit**, no
outstanding "changes requested", and the label if one is configured. `--head` makes it
fail if the PR moved since you looked. Do not re-implement the gate in prose, and do
not keep a second hand-written checklist beside it: two sources of truth drift apart.

If the team's agents share one GitHub account, use review comments
(`orch merge-gate <PR> --reviews comments --task <id>`, approvals posted with
`orch review approve`).

## Merge and re-check

1. `gh pr merge <PR> --squash` (or the team's merge style).
2. **Read it back:** `gh pr view <PR> --json state,mergeCommit` must show `MERGED`
   and a commit. Anything else did not merge.
3. **Re-check the rest before the next merge.** `mergeable` often reads `UNKNOWN` for
   a short while after a merge; poll until it resolves, do not guess. A PR that touches
   the same files or module as the one just merged needs its CI re-run, or at least a
   `git merge-tree` check. No text conflict does not mean no semantic conflict.
4. After the last merge, check the whole open list for new conflicts once more.
5. Log each merge: PR, merge commit sha, and the gate output line.

## Stacked PRs

Before merging a parent, retarget each child to the base branch
(`gh pr edit <child> --base main`). Deleting the parent's branch on merge otherwise
closes the children.

## Never

- Batch merges.
- Use an approval of an older head commit for a new one.
- Merge "while I'm at it" a PR that did not pass the gate.
- Decide on the human's behalf when the gate needs an exception. Ask, with a table:
  PR | what it changes | why it matters | what the gate is missing.
