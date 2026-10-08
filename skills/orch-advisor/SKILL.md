---
name: orch-advisor
description: Optional diagnosis recipe. Ask a fresh agent, read-only, to diagnose a problem the working agent cannot solve. It returns a falsifiable five-section diagnosis that the working agent then tests by running. Use when a worker is repeatedly BLOCKED on the same kind of problem, reaches the retry limit its operator set, or reports "underdetermined", and for a single deep question (root cause, cost anomaly, what a check really verifies). Not for missing permission, money decisions, or a missing log or instrument.
---

# /orch-advisor — an optional read-only diagnosis recipe

## Step 0: classify the block before spending anything

| Block | Advisor? | Do instead |
|---|---|---|
| Needs a human decision or permission | no | send a `QUESTION` to whoever decides |
| Needs money approved | no | ask the budget owner |
| Missing instrument (no log, no reproduction, no error text) | no | build the instrument first |
| Unexplained failure, spec gap, cost anomaly, "underdetermined" | **yes** | continue below |

A diagnosis of a permission problem produces a plan nobody can use.

## Trigger

- A worker reports `BLOCKED` repeatedly on the same kind of problem;
- a worker reaches the attempt limit its operator set;
- a worker says the problem is underdetermined;
- the lead names one deep question.

## Invocation

Start a **fresh** agent, not a continuation of the stuck one: isolation is the point.
Read-only, no spending. Which agent or model runs it, at what settings and with what
limits, follows the operator's configured policy.

The brief carries, verbatim:
- no writes except the diagnosis file; no paid calls;
- "Reproduce before you plan." The diagnosis names the exact commit and worktree in its
  first lines;
- "Never speculate about code you have not opened." / "Recognizing a name is not the
  same as knowing its current state; check names, versions and facts with a tool
  before asserting them.";
- the inputs: logs, the reproduction command, and the worker's own failure record.
  Never an oral summary.

Output path: `$ORCH_HOME/advisor/<topic>-<date>/DIAGNOSIS.md`.

## Output contract: five sections, all required

1. **Reproduced facts**, each with its instrument (file:line, command plus literal
   output).
2. **Ranked hypotheses**, each with a falsifying experiment: what to run, and what
   result kills it.
3. **Smallest plan**, with a failing test to write first and who owns it.
4. **What would prove this diagnosis wrong.**
5. **Rejected alternatives and why.** This is the part that transfers: a model's raw
   reasoning is not returned and is not a faithful record, so an explicit, falsifiable
   trace is the only usable form.

Every diagnosis also states: money spent (must be 0), tool calls used, files changed
(only the diagnosis file).

## Using the diagnosis

- The worker runs the diagnosis's own falsifying experiments first and posts the
  results.
- A falsified hypothesis goes back as a new fact for the next diagnosis. It is not
  patched around.
- The plan is reviewed like any other change, by an agent that did not write it.

## Hard rules

- No diagnosis without a reproduction and a pinned commit.
- No number in the diagnosis without the instrument that produced it.
- The advisor never edits code, never spends, never posts outside the team.
