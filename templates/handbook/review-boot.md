---
name: review-boot
description: Start this session as a REVIEWER - review one change independently at its current head commit, record the verdict where the merge gate reads it, and report. Run it at the start of every session that reviews other agents' work.
---

# Reviewer boot

A reviewer decides whether one change is correct, independently of its author and of any
other reviewer. The verdict is only worth something if it is bound to the exact commit that
was reviewed. Run the steps in order.

## 0. Name yourself

```sh
export ORCH_AGENT=r1
```

You may not review a change you wrote, and a review from the change's own author never
counts: `orch merge-gate` ignores it. If all agents share one code-host account, the
reviewer needs its own account or app identity, or the team uses review comments: record
your verdict with `orch review approve|changes|reject <pr> --as $ORCH_AGENT --head <sha>`.

## 1. Pick up the review and pin the head

```sh
orch msg read                                   # which change, from whom
orch task claim review-<pr>                     # one reviewer per review task
gh pr view <pr> --json headRefOid,author        # the commit you are about to review
```

Write the head commit down. Everything below is about that commit only.

## 2. Review independently

- Read the whole diff yourself. Build your own checklist from the code, the task brief and
  `protocols.md`, not from another reviewer's findings.
- Wait for CI on this head. CI results on the same head are shared ground truth that every
  reviewer may use; another reviewer's local test run is not.
- Run what you need yourself: the tests, a reproduction of each claimed fix, a check that
  would fail if the fix were wrong.
- Every finding carries evidence: a failing command, a file and line, a concrete input.
  Severity words without evidence are opinions and do not block.

## 3. Fix rounds: review the change, not the whole world again

When the author pushes fixes after your first review:

1. check each item you asked for: closed, partly closed or open, citing the fixing commit;
2. review the new commits for problems the fix itself introduced;
3. raise a new blocker anywhere only with evidence (data loss, security, silent failure,
   broken build).

Do not add new non-blocking requests that were visible in the first round. Put them in a
clearly marked "later" note that does not affect the verdict. If the fix rewrote the core of
the change, say so and do a full review instead.

## 4. Record the verdict where the gate reads it

```sh
gh pr review <pr> --approve -b "Reviewed at <head>: <one-line reason>"
gh pr review <pr> --request-changes -b "<the findings, with evidence>"
```

A push after your approval makes it stale: the gate counts only approvals of the current
head commit. Re-review the new commits and approve again if they are sound.

## 5. Report and release

```sh
orch msg send DONE --to lead -m "review <pr> at <head>: APPROVED | CHANGES REQUESTED; <findings or 'none'>; checked: <commands and results>"
orch task release review-<pr>
```

## Rules that do not bend

- Your verdict is yours. Nobody upgrades or reinterprets it; if it is wrong, you replace it.
- "Approve after fixes" is not an approval. Approve only what you would merge as it stands.
- Two reviews that copy each other count as one.
