# ORCH-os skill pack (draft)

Status: **draft.** No `orch` command installs these files, and they are not part of the
npm package. This release installs the role handbook that `orch init` writes
(`lead-boot.md`, `worker-boot.md`, `review-boot.md`, `protocols.md`); that handbook is
all a team needs. A skill here is an optional recipe a person chooses to use: copy its
folder into your agent's skills directory by hand to try it.

These are agent skills for running a team of CLI coding agents with ORCH-os: what to do
when the human leaves, returns or goes to sleep, how to fan one goal out, how to merge
safely, how to keep research and decisions findable. None of them grants an agent any
authority it did not already have, and none is a product mode or an installed service.
Each skill is one folder with a `SKILL.md` (YAML frontmatter `name` + `description`,
then the procedure) in the format Claude Code loads from
`.claude/skills/<name>/SKILL.md`. Other agent CLIs can read the same files as plain
Markdown.

They use ORCH-os primitives (`orch msg`, `orch mailbox`, `orch task`, `orch worker`,
`orch merge-gate`, `orch mem`, `orch load`) and keep their own state under
`$ORCH_HOME` (default `~/.orch`).

## The skills

| Skill | Use it when | State it keeps |
|---|---|---|
| `away` | the human leaves and the team keeps working | `$ORCH_HOME/away.json` |
| `back` | the human returns: one delta report and the queued decisions | reads `away.json`, archives it |
| `sleep` | everything stops for the night; the morning restarts from a snapshot | `$ORCH_HOME/sleep.json` |
| `caffeine` | the machine must stay awake while the team works unattended | `$ORCH_HOME/caffeine.pid` |
| `night-shift` | overnight work limited to reversible, zero-cost tasks | `$ORCH_HOME/night.json` |
| `insight` | reading material: teach it, then add only insight that survives a test | a pointer in `orch mem` |
| `research-library` | research that must stay findable: a fixed folder contract plus an index | `$ORCH_HOME/research/` |
| `record` | writing a durable trace of a decision, finding or incident | — |
| `progress` | percent complete per project, from milestones with evidence | `$ORCH_HOME/progress.json` |
| `orch-swarm` | one goal as parallel work: task graph, claims, evidence-based acceptance | `orch task` claims |
| `serial-merge` | merging: one PR at a time, gate first, re-check after each | — |
| `orch-advisor` | optional diagnosis recipe when a worker is stuck: a read-only diagnosis by a fresh agent, then test it by running | `$ORCH_HOME/advisor/` |
| `product-demo-storyboard` | planning a 30–60 second product demo video | — |

Pairs: `away` ↔ `back`; `sleep` ↔ the next morning's lead boot (the handbook's
`lead-boot.md`); `caffeine` usually runs with `away` or `night-shift`; `insight` feeds
`research-library`; `orch-swarm` may hand a stuck task to `orch-advisor`.
