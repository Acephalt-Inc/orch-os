# ORCH-os skill pack

Install the bundled skills for Claude in a workspace or for your user account:

```sh
orch skills install --host claude --scope workspace
orch skills install --host claude --scope user
orch skills status --host claude --scope workspace
orch skills uninstall --host claude --scope workspace
```

Use `--dry-run` to preview changes and `--only away,back` to select skills when
installing or uninstalling. `orch init --everyday` shows the install command;
`orch init --everyday --with-skills` installs the pack in the current workspace.
Claude Code loads workspace skills from `.claude/skills/<name>/SKILL.md` and user
skills from `~/.claude/skills/<name>/SKILL.md`. The installer preserves user files;
where replacement is authorized it makes a backup, and uninstall removes only
installer-owned material. Skills are optional instructions, not services, and grant
no extra authority.

| Skill | Use it when |
|---|---|
| `away` | work continues while the person is away |
| `back` | the person returns and needs a delta report |
| `caffeine` | a machine must stay awake for bounded work |
| `daily-brief` | a ranked morning operating brief is needed |
| `decision-inbox` | decisions need evidence and recommendations |
| `insight` | material needs a teaching digest and tested insights |
| `night-shift` | overnight work is restricted to reversible, zero-cost actions |
| `ops-followup` | commitments and follow-up drafts need tracking |
| `orch-advisor` | a reproduced problem needs independent diagnosis |
| `orch-swarm` | one goal benefits from parallel task ownership |
| `product-demo-storyboard` | a short product demo needs a storyboard |
| `progress` | project milestones need an evidence-backed progress report |
| `record` | a decision, finding, incident, or handoff needs a durable record |
| `research-library` | research and its sources need a reusable archive |
| `serial-merge` | reviewed PRs need a serial human-merge handoff |
| `sleep` | the team should stop safely and save restart state |
