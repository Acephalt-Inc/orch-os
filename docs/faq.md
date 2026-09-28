# FAQ

**Which agents does it work with?**
Any CLI agent that can run one task non-interactively with the task text on stdin. `orch init` has templates for a few common ones (Claude Code, Codex CLI, Gemini CLI, Qwen Code). For anything else, add an `[agents.NAME]` table with a `command` list, or pass a command after `--` to `orch worker start`.

**How do I use the handbook with Claude Code?**
Start each interactive session by telling it its role and file, for example: `export ORCH_AGENT=lead`, start `claude`, then say "Read ~/.orch/handbook/lead-boot.md and follow it." To load the files as skills instead, run `orch init --dir .claude/skills --layout skills` in the repository (or `--dir ~/.claude/skills` for every project); each file becomes `NAME/SKILL.md` with the `name` and `description` frontmatter Claude Code expects, and you can invoke it by name. Background workers started with `orch worker start --agent claude` get the task file on stdin; put "Read ~/.orch/handbook/worker-boot.md first" at the top of the task file.

**How do I use it with Codex CLI?**
The same way: `export ORCH_AGENT=w1`, start `codex`, and say "Read ~/.orch/handbook/worker-boot.md and follow it." To have Codex load the rules on its own, add a line to the repository's `AGENTS.md` that points at the role file, or run `orch init --dir ~/.codex/skills --layout skills` if your Codex version reads skill folders. Workers started with `--agent codex` run `codex exec` with the task on stdin.

**Does `orch doctor` need an agent, GitHub or a network?**
No. With Node.js ≥ 20 and git on a POSIX system, the doctor passes. Agents, `gh`, `timeout` and the handbook show as SKIP when absent. `merge-gate --fixture` works fully offline.

**All my agents use one GitHub account. Why does the merge gate never pass?**
GitHub does not let a PR's author approve it, and the default gate ignores author reviews as well. Use review comments instead: the reviewing agent runs `orch review approve PR --as r1`, which posts a comment whose first line is `ORCH-REVIEW APPROVE <full head sha> by r1`, and you check with `orch merge-gate PR --reviews comments --task ID` (or set `[review] source = "comments"`). A review comment counts only for the PR's current head commit and only when its agent is not the holder of task `ID` in `orch task`; a later `CHANGES` or `REJECT` review comment at the head blocks, and CI must still be green. See the solo flow in the README.

Know what this is: a process gate between cooperating agents on one account, **not a security boundary**. Anyone who holds the account's token can post a review comment under any agent name, and GitHub cannot tell the agents apart. If you need an approval that the author cannot produce, give the reviewing agent its own GitHub account or a GitHub App identity, have it submit a normal approving review, and keep the default `github` source.

**Can I use the merge gate without GitHub?**
Not live: the live mode reads GitHub through `gh`. The rule it applies is plain, though (CI green, N non-author approvals at the current head, no changes requested), and `protocols.md` writes it so a lead can apply it by hand on any other forge. `--fixture PATH` accepts any JSON file in the `gh pr view --json` shape, so a small adapter can feed it data from elsewhere.

**How does an agent wait for an answer?**
`orch msg watch --as w1 --count 1 --timeout 900` blocks until one new message for `w1` arrives (or 15 minutes pass). Nothing is lost while nobody watches: a message stays pending until the reader acks it.

**What if a worker dies while it holds a task?**
Its claim expires after `--seconds` (default `[tasks] default_seconds`, 2 hours), and then anyone can claim the task. Long tasks should `orch task renew ID --expected-epoch N` now and then; a renew that fails means the task is no longer yours.

**My agent needs extra flags (permissions, model, sandbox).**
Edit its `command` list in `~/.orch/config.toml`. `orch init` writes a minimal headless command on purpose: what an agent may do unattended is your decision.

**I installed a new agent after `orch init`.**
Run `orch agents` to see it, then `orch init --force` to regenerate the config (mailbox, messages, tasks, notes and the handbook are kept), or add the `[agents.NAME]` table by hand.

**Why absolute paths in the config?**
Workers are often started from cron, whose PATH is minimal. Symlinks are kept as they are, so upgrading an agent that swaps its link target does not break the config.

**Is the lease a lock on the repository?**
No. It decides which session acts as lead. It prevents two sessions from both believing they lead, and fences a session that lost the role through the epoch. Task claims do the same per task; worktrees keep workers out of each other's files.

**Does it merge PRs?**
No. `merge-gate` answers yes or no; you or your automation performs the merge.

**How do I run the load governor continuously?**
Run `orch load` once a minute from cron or any other scheduler. Each call takes one sample and updates `load.json`; `orch worker start` reads it.

**How do I add CPU temperature?**
Set `[load] temp_command` to any command that prints one number in degrees C, then add `temp_c` thresholds to `busy`, `high` and `critical`.

**Why does `orch mem` refuse to overwrite or delete an entry?**
So that what the team once believed stays readable, with a pointer to what replaced it. Add the new entry, then `orch mem retire OLD --superseded-by NEW`. `search --all` shows both.

**Where is everything stored?**
Under `~/.orch` (or `$ORCH_HOME`): `config.toml`, `lease.json`, `mailbox.md`, `messages.jsonl`, `cursors/`, `tasks/`, `mem/`, `handbook/`, `workers/`, `worktrees/`, `load.json`. `install.sh` puts the package in `~/.orch/lib/orch-os` and the launcher in `~/.local/bin/orch`; npm puts it in its global prefix. To uninstall, `npm rm -g orch-os` or delete those paths.

**Windows?**
Not supported. Workers use POSIX process groups and signals. macOS and Linux work.
