---
name: progress
description: Project-level progress, not per-task status. Use when the human asks "where are we", "big picture" or "how far along is X", on /progress, and at the end of every report that closes a task. Renders percent complete per project from a milestone registry where each milestone carries evidence, and prints only what moved since the last render.
---

# /progress — projects, milestones, percent done

Per-task status already lives in `orch task list` and `DONE` messages. This adds the
missing layer: **project → milestones → percent complete**, and at every task close
the line "this task moved project X from a% to b%".

## The registry

`$ORCH_HOME/progress.json`:

```json
{
  "projects": {
    "billing-v2": {
      "owner": "lead",
      "north_star": "users can switch plans without asking for help",
      "next": "t-41",
      "milestones": [
        {"name": "plan-switch API", "status": "done", "weight": 1, "evidence": "merged abc1234"},
        {"name": "proration tests", "status": "in_progress", "weight": 1, "evidence": ""},
        {"name": "UI flow", "status": "todo", "weight": 1, "evidence": ""}
      ]
    }
  }
}
```

Status is `done`, `in_progress`, `todo` or `blocked`.
**Percent = (Σ weight of done + 0.5 × Σ weight of in_progress) / Σ weight.** In-progress
counts half, so "started" never reads as "finished".

## Render

```sh
python3 - "$ORCH_HOME" <<'EOF'
import json, os, sys
home = sys.argv[1]; reg = json.load(open(f"{home}/progress.json"))
last_p = f"{home}/progress.last.json"
last = json.load(open(last_p)) if os.path.exists(last_p) else {}
now = {}
for name, p in reg["projects"].items():
    ms = p["milestones"]; tot = sum(m["weight"] for m in ms) or 1
    pct = round(100 * (sum(m["weight"] for m in ms if m["status"] == "done")
              + 0.5 * sum(m["weight"] for m in ms if m["status"] == "in_progress")) / tot)
    now[name] = pct
    flag = " (done without evidence!)" if any(m["status"] == "done" and not m["evidence"] for m in ms) else ""
    moved = f"  {last[name]}% -> {pct}%" if name in last and last[name] != pct else ""
    print(f"{name:24} {pct:3}%  next: {p.get('next','-')}{moved}{flag}")
json.dump(now, open(last_p, "w"))
EOF
```

## When to use it

1. **The human asks for progress** → render and paste the table as-is, no extra prose.
2. **At the end of every report that closes a task** → add a `Project progress` section
   with only the projects that moved, one line each
   (`billing-v2 33% → 50%: proration tests merged`). If nothing moved, write
   "Project progress: no change". Do not omit the line.
3. **Morning report or `/back`** → the full table after the other sections.

## Keeping the registry honest

- When a task finishes a milestone, update its status and evidence **now** (PR, commit
  sha, or path to the output). A `done` without evidence is invalid; the renderer
  flags it.
- New project → register it immediately: owner, one-sentence `north_star`, `next`
  task, and milestones cut by **acceptable outcomes**, not by steps. Start every
  weight at 1; let the human adjust.
- A milestone that no longer applies is deleted, not kept as a tombstone.
- A merged PR mentioned in the evidence does not by itself mean the milestone is done.
  Check the outcome.

## Hard rules

- A percentage comes only from the registry plus evidence. Never estimate one ("about
  70%").
- Tables and short lines; every row's evidence names its instrument.
