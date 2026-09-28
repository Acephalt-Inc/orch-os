---
name: orch-advisor
description: Ask the strongest model you have, read-only and at its highest reasoning setting, to diagnose a problem the working agent cannot solve. It returns a falsifiable five-section diagnosis that the working agent then tests by running, not by arguing. Use when a worker is BLOCKED twice on the same kind of problem, hits its retry limit, or reports "underdetermined", and for a single deep question (root cause, cost anomaly, what a check really verifies). Not for missing permission, money decisions, or a missing log or instrument.
---

# /orch-advisor — diagnose with the strongest model, execute with a cheaper one

## Step 0: classify the block before spending anything

| Block | Advisor? | Do instead |
|---|---|---|
| Needs a human decision or permission | no | send a `QUESTION` to whoever decides |
| Needs money approved | no | ask the budget owner |
| Missing instrument (no log, no reproduction, no error text) | no | build the instrument first |
| Unexplained failure, spec gap, cost anomaly, "underdetermined" | **yes** | continue below |

A strong model spent on a permission problem produces a plan nobody can use.

## Trigger

- A worker reports `BLOCKED` twice on the same kind of problem;
- a worker hits its attempt limit (for example three rounds);
- a worker says the problem is underdetermined;
- the lead names one deep question.

## Invocation

Start a **fresh** agent, not a continuation of the stuck one: isolation is the point.
Read-only, no spending. In Claude Code:

```
Agent(subagent_type="general-purpose", model="<your strongest model>", prompt=<brief>)
```

The brief carries, verbatim:
- the highest reasoning effort available, and an output budget large enough for the
  full diagnosis (a diagnosis cut off mid-section is a failed pass);
- a tool-call limit (about 40); no writes except the diagnosis file; no paid calls;
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

## Execution: falsify by running, not by opinion

- The worker runs the advisor's own falsifying experiments first and posts the
  results.
- A plan is rejected only by a failed experiment, never by a counter-argument.
  Otherwise the cheaper agent drifts toward the plan that is least work for it.
- A falsified hypothesis goes back to the advisor as a new fact. It is not patched
  around.
- Independent review of the plan still happens, but a reviewer cannot veto it without
  a run.

## Measure it, with a control

Log one line per advisor pass: effort, rounds to resolution, cost, falsified yes/no.
Log the same line for comparable blocks handled **without** the advisor (same kind of
problem, same worker), or rounds-to-resolution cannot be attributed. Wait for at
least 10 passes before quoting a number.

## Hard rules

- The highest effort is for advisor passes, not routine work.
- No diagnosis without a reproduction and a pinned commit.
- No number in the diagnosis without the instrument that produced it.
- The advisor never edits code, never spends, never posts outside the team.
