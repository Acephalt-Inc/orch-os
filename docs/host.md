# Claude host pack

```text
orch host install --workspace PATH --host claude [--preset coding|research|ops] [--scope workspace|user] [--dry-run]
orch host status --workspace PATH --host claude [--scope workspace|user]
orch host uninstall --workspace PATH --host claude [--scope workspace|user] [--dry-run]
```

Defaults are `coding` and `workspace`. Installation merges permission rules and three hooks into `.claude/settings.json` in the workspace, or `~/.claude/settings.json` with user scope. Both scopes add a marked working agreement to the workspace's `CLAUDE.md`. Existing settings and instructions are preserved, with backups and an ownership record for removal. A dry run writes nothing. Status reports permissions, each hook and the agreement as `INSTALLED`, `MODIFIED-BY-USER` or `MISSING`.

Uninstall restores the original bytes when the installed file is unchanged. If you changed it, uninstall removes only unchanged additions that it owns and preserves your edits. Keep the ownership record and backup until uninstall finishes. Status describes files; it does not prove that a running Claude session loaded them.

The pack does not grant permission for irreversible or outward actions. Existing user rules remain in effect. Test scripts run repository code: review a repository before granting its tests standing permission.

## Permission presets

Every preset allows exactly `Read`, `Grep`, `Glob`, `Bash(git status)`, `Bash(git diff)`, `Bash(git log)` and `Bash(pwd)`, plus these entries:

| Preset | Additional allow entries |
| --- | --- |
| `coding` | `Bash(npm test)` |
| `research` | `Bash(ls)`, `Bash(cat README.md)` |
| `ops` | `Bash(ls)` |

These are exact command rules. Commands with extra arguments can still prompt. The presets add no push, publish, deletion, deployment, payment or messaging command, and no general shell, script runner or network permission.

Ownership records contain the original file bytes. Workspace scope stores its record in `.orch-host-workspace/`; user scope uses `~/.orch-host-user/` and records the workspace that owns the agreement. A user-scope install is managed from that workspace; another workspace cannot replace its ownership record. Existing agreement markers cause an installation conflict rather than acquiring someone else's block. Use one scope per workspace.

## Hook entrypoints

```text
orch hook session-start [--workspace PATH]
orch hook pre-tool-guard [--workspace PATH]
orch hook stop-continue [--workspace PATH]
```

Hooks receive JSON on stdin. The installer uses Node's CLI script with a separate argument vector, so paths with spaces work without shell quoting. Workspace scope pins its workspace; user scope uses the event's `cwd`. Node and an installed ORCH package must remain available.

`session-start` prints a short block of local context, capped at 40 lines. Resume notes and memory are caller-supplied data. The shared accepted-memory index is `workspace-notes/shared/INDEX.md`; the hook does not load personal memory into shared context.

The workspace's `.orch/host-context.json` explicitly records tasks:

```json
{
  "tasks": [
    { "id": "review-parser", "approved": true, "status": "in_progress" },
    { "id": "compare-options", "approved": false, "status": "open" }
  ]
}
```

Record actual user approval before setting `approved` to `true`. A task claim alone is not approval. Set a task's `stop_reason` or the record's top-level `stop_reason` when pausing for a decision or at the user's request; use `done` for completed tasks. This file is an ORCH host-pack convention, not a Claude setting. Installation does not invent tasks or approvals.

`stop-continue` blocks once per session when an approved task is in progress without a stop reason. It prints `{"decision":"block","reason":"continue <task>"}` with exit code 0. It honors `stop_hook_active` and keeps a durable session cap under `.orch/host-sessions/`. Missing, invalid or unavailable task state permits stopping. It does not infer approval or stop reasons from transcripts.

Uninstall preserves the task record, accepted memory, private resume notes and session-cap files. They are runtime data, separate from the settings and agreement installed by this command.

`pre-tool-guard` returns exit code 2 and a one-line stderr reason for long foreground sleeps and blocking watches. Poll or use a background watcher instead. Short waits and bounded or background watches are allowed. The guard recognizes common shell forms; it is not a shell interpreter or a security boundary.

## Contract sources and limits

Claude's [hook reference](https://code.claude.com/docs/en/hooks) documents event names, JSON stdin, the Node exec form, PreToolUse exit code 2, Stop blocking JSON, `stop_hook_active` and SessionStart context. Its [settings guide](https://code.claude.com/docs/en/settings) documents both settings locations, and its [permission guide](https://code.claude.com/docs/en/permissions) documents allow-rule syntax. The implementation tests these contracts with fixture inputs. Actual Claude activation and native Windows execution need separate host testing. Codex host support is a follow-up.
