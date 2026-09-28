---
name: back
description: Use when the human returns after /away — they invoke /back or say "I'm back". Builds one delta report against the away snapshot (bad news first), lists the decisions that were queued for them in a four-part form, re-checks every inherited "needs the human" item before presenting it, and archives the snapshot. Not for a status request when no /away is active.
---

# /back — the human returns, hand over the delta

The other half of `/away`. The report comes before the human's next instruction,
unless that instruction is itself urgent.

## Steps

1. **Read the left edge.** If `$ORCH_HOME/away.json` does not exist, no absence is
   active: say so and give an ordinary status instead.

2. **Collect the delta**, everything measured against `away_at`:

   | Source | Command | Derive |
   |---|---|---|
   | PRs | `gh pr list --state all --limit 500 --json number,title,state,mergedAt,headRefOid` | merged / newly opened / now passing the gate / still failing, vs `open_prs` |
   | Tasks | `orch task list --json`; `orch msg read --all --json` | `DONE` and `BLOCKED` messages since `away_at`, claims that changed hands |
   | Decisions | `$ORCH_HOME/decisions.md` | items added during the absence |
   | Money | whatever billing or usage source the team has | actual spend vs `spend_cap` |

   Timestamps from `gh` are UTC. Convert them before comparing with `away_at`.

3. **Re-check every inherited item before presenting it.** A "needs the human" line
   written by an earlier session is a claim, not a fact. Re-read its source today (the
   PR state, the failing check, the error the credential returned) and write that
   reading next to the item. Copying a predecessor's judgment forward creates
   decisions that do not exist.

4. **Deliver one report, bad news first:**

   | Section | Content |
   |---|---|
   | Headline | all fine / something broke, plus the single most important fact |
   | Incidents | if any, directly under the headline; otherwise "none" |
   | PRs | merged (with commit sha), ready to merge (PR, what changed, why it matters), newly opened, still failing |
   | Tasks | done / in progress / newly started, one line each |
   | Money | actual vs cap |

5. **Decisions get their own section.** Each item has all four parts:
   - **The decision** in one sentence.
   - **What you need to know**: the smallest set of facts, each with its source.
   - **If nobody decides**: the consequence. No consequence means it is not a
     decision item.
   - **Recommendation**: one word or letter, not a menu.

   List only items added during the absence or now due. Point to the file for the
   full backlog; do not replay it.

6. **Archive the snapshot** so a stale one cannot feed a second report:
   `mv "$ORCH_HOME/away.json" "$ORCH_HOME/away.last.json"`. Then
   `orch mailbox post lead -m "Human back at <time>; normal routing resumed."`

## Not this skill

- The team was stopped overnight and is being restarted: that is a morning boot from
  the `/sleep` snapshot, not `/back`.
- The human never left and just wants status: give an ordinary status.
