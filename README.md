<h1 align="center">ORCH-os</h1>

<p align="center">A team layer for CLI coding agents.</p>

<p align="center"><a href="docs/concepts.md">Documentation</a> · <a href="docs/commands.md">Commands</a> · <a href="docs/faq.md">FAQ</a> · <a href="README.zh.md">中文</a></p>

<p align="center">
  <a href="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml"><img src="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/orch-os"><img src="https://img.shields.io/npm/v/orch-os" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20dual-blue" alt="PolyForm dual license"></a>
</p>

ORCH-os helps several CLI coding agents work in one repository. A lease-held lead, shared mailbox, task board with exclusive claims, review-based merge gate, and detached workers give the team a common operating layer. It works alongside Claude Code, Codex CLI, and other command-line agents.

Author: Winnicent Zuo

## Install

Requires Node.js 20 or newer on macOS or Linux. Install the `orch` command globally, or run it once with `npx`:

```sh
npm i -g orch-os
# or: npx orch-os init
```

## Why ORCH-os

- **One lead:** A role lease records the holder and fences a previous holder with an epoch.
- **Clear ownership:** Each task has one claim holder until release or expiry.
- **Messages that wait:** Addressed questions and answers have per-reader cursors and acknowledgements.
- **Shared context:** A Markdown mailbox and a generated role handbook make team state visible.
- **Separate workspaces:** Workers can run in their own Git worktrees and branches.
- **Review at the current head:** The merge gate checks CI and non-author approvals for the live PR commit.
- **Durable notes:** Rules and lessons stay in files; retiring one keeps its history.

## What ORCH-os provides

The status below distinguishes commands on the current `main` branch from work still under review and future directions. “Planned” is a category, not a shipped command.

### Workflow and dispatch

| Feature | Command or file | Status |
|---|---|---|
| One lead with an epoch-fenced lease | `orch lease` | Available |
| Exclusive task claims and detached workers | `orch task`, `orch worker` | Available |

### Review and merge gates

| Feature | Command or file | Status |
|---|---|---|
| Gate on CI and reviews of the current PR head | `orch merge-gate` | Available |
| Review comments for agents sharing one GitHub account | `orch review`, `orch merge-gate --reviews comments --task ID` | Available |

The comment-based option is a process gate between cooperating agents, not a security boundary: anyone with the account token can post under an agent name. The gate reports a verdict; it never merges the PR.

### Scheduling and liveness

| Feature | Command or file | Status |
|---|---|---|
| Renew a lead lease and wait for addressed messages | `orch lease renew`, `orch msg watch` | Available |
| Install operating-system jobs for periodic checks | `orch schedule` | In review ([PR #6](https://github.com/Acephalt-Inc/orch-os/pull/6)) |

### Resources

| Feature | Command or file | Status |
|---|---|---|
| Sample machine load and refuse new workers at configured load levels | `orch load`, `orch worker start` | Available |

### Evidence and logs

| Feature | Command or file | Status |
|---|---|---|
| Worker output and process records | `orch worker`, `~/.orch/workers/` | Available |
| A unified history of task outcomes | — | Planned |

### Agent communication

| Feature | Command or file | Status |
|---|---|---|
| Shared entries and addressed messages with acknowledgements | `orch mailbox`, `orch msg` | Available |

### Profiles: accounts and people

| Feature | Command or file | Status |
|---|---|---|
| Design for solo and team account setups | `docs/profiles.md` | In review ([PR #5](https://github.com/Acephalt-Inc/orch-os/pull/5)) |
| Profile commands and review-strength rules | `orch profile`, `src/profile.ts` | In review ([PR #7](https://github.com/Acephalt-Inc/orch-os/pull/7)) |

### Notes lifecycle

| Feature | Command or file | Status |
|---|---|---|
| Add, search, and retire file-backed notes | `orch mem` | Available |

### Learning and refinement

| Feature | Command or file | Status |
|---|---|---|
| Suggest reusable lessons from completed work | — | Planned |

### Policy and approvals

| Feature | Command or file | Status |
|---|---|---|
| Require a label and current-head approval before a positive gate verdict | `orch merge-gate --label NAME` | Available |
| Select review rules from an account-and-people profile | `src/profile.ts` | In review ([PR #7](https://github.com/Acephalt-Inc/orch-os/pull/7)) |

### Goals and verification

| Feature | Command or file | Status |
|---|---|---|
| Check local prerequisites | `orch doctor` | Available |
| Track goals through completion checks | — | Planned |

### Telemetry and cost

| Feature | Command or file | Status |
|---|---|---|
| Read local load samples | `orch load` | Available |
| Record per-task cost | — | Planned |

### Agent discovery and isolation

| Feature | Command or file | Status |
|---|---|---|
| Find installed agent CLIs and place workers in separate Git worktrees | `orch agents`, `orch worker start --worktree` | Available |
| Verify agent identity and sandbox boundaries | — | Planned |

### Version and configuration

| Feature | Command or file | Status |
|---|---|---|
| Show the installed version and resolved configuration | `orch --version`, `orch config` | Available |

## Getting Started

In your repository, initialize ORCH-os, then point a lead session and a worker session in Claude Code or Codex CLI at the generated role files:

```sh
cd /path/to/repository
orch init
orch doctor
orch lease acquire --session lead
orch task claim first-task --as w1
```

The role files are `~/.orch/handbook/lead-boot.md` and `~/.orch/handbook/worker-boot.md`. See the [FAQ](docs/faq.md) for how to load them in either agent. With a one-off install, replace `orch` with `npx orch-os`.

## Commands

```sh
orch init                                   # Create config, mailbox, and role handbook
orch agents                                 # See detected and configured agent CLIs
orch doctor                                 # Check prerequisites
orch lease status                           # Show the lead lease
orch lease acquire --session lead           # Take the lead lease
orch mailbox read                           # Read shared mailbox entries
orch msg send QUESTION --as w1 --to lead -m "Need a decision"  # Send an addressed question
orch msg read --as lead                     # Read the lead's pending messages
orch task claim first-task --as w1          # Claim a task exclusively
orch worker start w1 --agent claude --worktree --task task.md  # Start a detached worker
orch worker list                            # Show workers
orch merge-gate 101 --fixture approved      # Try the gate with an offline fixture
orch load                                   # Sample machine load
orch mem search review                      # Search durable notes
```

Full flags and exit codes: [Command reference](docs/commands.md).

## Built for multi-agent work

- **Lead and worker roles:** The generated handbook gives each session a starting protocol; the CLI records the lead lease and task claims.
- **Addressed messages:** `msg` supports typed messages, acknowledgements, and waiting for replies; `mailbox` holds shared entries.
- **Worker controls:** Detached processes have logs and support a time limit when `timeout` or `gtimeout` is installed; optional Git worktrees isolate file edits.
- **Human-controlled merges:** `merge-gate` reports whether review conditions pass. It does not merge a PR.
- **Solo review flow:** `orch review approve` posts a review comment, and `orch merge-gate --reviews comments --task ID` checks it against the current head and task holder.

## Documentation

- [Concepts](docs/concepts.md) — roles, leases, messages, claims, workers, and notes.
- [Commands](docs/commands.md) — subcommands, flags, exit codes, and configuration.
- [FAQ](docs/faq.md) — Claude Code and Codex CLI setup, GitHub identity, and common questions.
- [Architecture](docs/architecture.md) — modules, local state files, and process model.
- [Migration](docs/migration.md) — moving from v1.1 to v2.
- [Test map](docs/tests-map.md) — correspondence between v1.1 and v2 tests.
- [Demo](docs/DEMO.md) — a scripted offline walkthrough.

## License

ORCH-os is source-available. You may use it under either of two licenses, whichever fits you ([LICENSE](LICENSE)):

- **Individuals: free.** Personal, non-commercial use (learning, hobby projects, research) is free under the [PolyForm Noncommercial License 1.0.0](LICENSE-NONCOMMERCIAL).
- **Companies: free for internal use.** Any company or organisation may use it inside its own operations, including as engineering tooling for its own teams, under the [PolyForm Internal Use License 1.0.0](LICENSE-INTERNAL-USE).
- **Not allowed without a commercial license:** selling ORCH-os, hosting it as a service for others, or building it into a product you offer to others. Commercial licensing: winnicent.zuo@acephalt.com.

This summary is for convenience; the two license texts are what apply.

See also [NOTICE](NOTICE) and [AUTHORS](AUTHORS). To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md).
