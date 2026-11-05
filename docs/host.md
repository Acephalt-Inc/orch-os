# Claude host pack

```text
orch host install --workspace PATH --host claude [--preset coding|research|ops] [--scope workspace|user] [--dry-run]
orch host status --workspace PATH --host claude [--scope workspace|user]
orch host uninstall --workspace PATH --host claude [--scope workspace|user] [--dry-run]
```

Defaults are `coding` and `workspace`. Installation merges permission rules and three hooks into `.claude/settings.json` in the workspace, or `~/.claude/settings.json` with user scope. Both scopes add a marked working agreement to the workspace's `.claude/CLAUDE.md`. Existing settings and instructions are preserved, with backups and an ownership record for removal. A dry run writes nothing. Status reports permissions, each hook and the agreement as `INSTALLED`, `MODIFIED-BY-USER` or `MISSING`.

Uninstall restores the original bytes when the installed file is unchanged. If you changed it, uninstall removes only unchanged additions that it owns and preserves your edits. Keep the ownership record and backup until uninstall finishes. Status describes files; it does not prove that a running Claude session loaded them.

The pack adds narrow command permissions and, in research, web tools. Existing user rules remain in effect. Test and build scripts run repository code: review a repository before granting its scripts standing permission.

## Permission presets

The constants in `src/host/presets.ts` define the complete allow lists. Every preset includes every common rule below, then only its own additions. These are allow rules, not a deny policy; existing user permissions and Claude's permission mode still apply.

### Common rules (coding, research and ops)

| Rule | Purpose |
| --- | --- |
| `Read` | Read files with the host's file tool. |
| `Grep` | Search file contents. |
| `Glob` | Find files by pattern. |
| `Bash(git status:*)` | Inspect worktree status, including format options. |
| `Bash(git diff:*)` | Compare revisions or paths, such as `git diff main`. |
| `Bash(git log:*)` | Inspect commit history with limits and paths. |
| `Bash(git show:*)` | Inspect a commit or object. |
| `Bash(git branch)` | List local branches; exact command only. |
| `Bash(git branch --list)` | Explicitly list branches; exact command only. |
| `Bash(pwd)` | Print the working directory; exact command only. |
| `Bash(ls:*)` | List directories or paths, such as `ls src`. |
| `Bash(orch mailbox read:*)` | Read mailbox entries with count/section options. |
| `Bash(orch host status:*)` | Inspect host installation permissions, hooks and agreement. |
| `Bash(orch lead status:*)` | Inspect lead-pack installation files. |

There is no `git branch` prefix: extra arguments can create, rename or delete branches. There is no broad `git`, `orch`, `node`, package-manager or shell-runner prefix. The ORCH entries above and below exist in the CLI command table; message reading with `--ack` is omitted because it changes state. There is no `orch mem read` or `orch mem recall` command in this CLI.

### Coding additions

These rules allow only the named script entrypoints, with arguments for filters and tool options. They do not allow arbitrary script names such as `test:deploy`.

| Rule | Purpose |
| --- | --- |
| `Bash(npm test:*)` | Run the test script, for example `npm test -- parser`. |
| `Bash(npm run test:*)` | Run the named test script. |
| `Bash(npm run lint:*)` | Run the named lint script. |
| `Bash(npm run typecheck:*)` | Run the named typecheck script. |
| `Bash(npm run build:*)` | Run the named build script. |
| `Bash(pnpm test:*)` | Run the test script with pnpm. |
| `Bash(pnpm lint:*)` | Run the lint script with pnpm. |
| `Bash(pnpm typecheck:*)` | Run the typecheck script with pnpm. |
| `Bash(pnpm build:*)` | Run the build script with pnpm. |
| `Bash(pnpm run test:*)` | Run the explicit pnpm test script. |
| `Bash(pnpm run lint:*)` | Run the explicit pnpm lint script. |
| `Bash(pnpm run typecheck:*)` | Run the explicit pnpm typecheck script. |
| `Bash(pnpm run build:*)` | Run the explicit pnpm build script. |
| `Bash(yarn test:*)` | Run the test script with Yarn. |
| `Bash(yarn lint:*)` | Run the lint script with Yarn. |
| `Bash(yarn typecheck:*)` | Run the typecheck script with Yarn. |
| `Bash(yarn build:*)` | Run the build script with Yarn. |
| `Bash(yarn run test:*)` | Run the explicit Yarn test script. |
| `Bash(yarn run lint:*)` | Run the explicit Yarn lint script. |
| `Bash(yarn run typecheck:*)` | Run the explicit Yarn typecheck script. |
| `Bash(yarn run build:*)` | Run the explicit Yarn build script. |
| `Bash(node --version)` | Inspect the Node version without allowing script execution. |

Scripts and their lifecycle hooks execute repository code and may write build output or perform other actions. Review scripts, package-manager configuration and forwarded arguments before granting standing permission, especially in user scope. Git inspection prefixes also accept flags such as `--output` and external diff/text conversion configuration; these lists do not enforce that every possible argument is read-only.

### Research additions

| Rule | Purpose |
| --- | --- |
| `WebSearch` | Search the web through the host tool. |
| `WebFetch` | Fetch web sources through the host tool from any domain. |

Research grants network access through these tools. To limit fetches, replace `WebFetch` with specific rules such as `WebFetch(domain:example.com)`. It does not grant shell network clients.

### Ops additions

| Rule | Purpose |
| --- | --- |
| `Bash(orch task status:*)` | Inspect one task's holder and expiry. |
| `Bash(orch task list:*)` | List task claims, optionally as JSON. |
| `Bash(orch mem search:*)` | Search durable notes by terms or type. |

Task inspection does not change claims, but the current lease implementation creates storage directories and takes a temporary lock while reading. No task claim/renew/release or memory add/retire permission is added.

### Matching and safety limits

Claude's [permission guide](https://code.claude.com/docs/en/permissions#compound-commands) documents that `:*` matches a command prefix at a word boundary and that compound commands are checked per subcommand. Thus `Bash(npm run test:*)` covers `npm run test -- parser`, while chaining `git status && git push` still requires permission for `git push`. The host performs this parsing; the preset tests check single-command rule shape and boundaries, not a replacement shell parser. Live Claude enforcement is not tested here.

No preset contains bare `Bash`, `Bash(*)`, or a direct allow rule for `git push`, `git commit`, `git reset`, `git checkout`, `git clean`, `rm`, `mv`, `npm publish`, `npm install`, `curl`, `ssh`, `sudo`, deployment, sending or email commands. Exclusion tests check these commands and mutating ORCH entrypoints against every preset. This does not audit the behavior of repository scripts or cancel broader permissions already granted elsewhere.

An existing install retains the rules recorded in its ownership manifest. To apply these new lists to an older install or change presets, uninstall from the owning workspace and reinstall with the desired preset; this preserves the existing backup and ownership contract.

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
