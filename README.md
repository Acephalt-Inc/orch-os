<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/acephalt-logo-white-text.png">
    <img src="assets/acephalt-logo-dark-text.png" alt="Acephalt" width="360">
  </picture>
</p>

<h3 align="center">ORCH-OS: A Team Layer for CLI Coding Agents</h3>

<p align="center"><a href="docs/concepts.md">Documentation</a> · <a href="docs/commands.md">Commands</a> · <a href="docs/faq.md">FAQ</a> · <a href="README.zh.md">中文</a></p>

<p align="center">
  <a href="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml"><img src="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/orch-os"><img src="https://img.shields.io/npm/v/orch-os" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20dual-blue" alt="PolyForm dual license"></a>
</p>

ORCH-os helps several CLI coding agents work in one repository. A lease-held lead, shared mailbox, task board with exclusive claims, review-based merge gate, and detached workers give the team a common operating layer. It works alongside Claude Code, Codex CLI, and other command-line agents.

Author: [Winnicent Zuo](https://www.linkedin.com/in/winnicent-zuo/)

## Install

Requires Node.js 22 or newer (24 LTS recommended) on macOS or Linux. Install the `orch` command globally, or run it once with `npx`:

```sh
npm i -g orch-os
# or: npx orch-os init
```

## Why ORCH-os

One coding agent needs a prompt. A team of agents needs an operating layer: someone leads, work has one owner, messages are delivered and answered, merges wait for independent review, and what the team learns survives the session. ORCH-os organizes that layer into 14 subsystems. Each has one job and a small set of rules it enforces.

| # | Subsystem | Responsibility | Parts | Status |
|---|---|---|---|---|
| 1 | Control plane | Exactly one lead; the team stays alive | Role lease with epoch fencing · lease renewal · scheduled background jobs · liveness watchers · derived operating mode | Lease: Available · Scheduling: In review ([#6](https://github.com/Acephalt-Inc/orch-os/pull/6)) · Watchers, mode: Coming soon |
| 2 | Goals and verification | A goal is written once; "done" is a runnable check | Goal registry · task templates · completion checks | Coming soon |
| 3 | Work execution | Every task has one owner and a clean worker lifecycle | Exclusive task claims · detached workers · time limits · per-worker Git worktrees · run history with ordered terminal states | Claims, workers, worktrees: Available · Run history: Coming soon |
| 4 | Agent messaging | Questions are delivered, answered and acknowledged | Typed, addressed messages · per-reader cursors · acknowledgements · wait for reply · shared mailbox | Available |
| 5 | Review and merge gates | Merge only on an independent review of the exact commit | CI at the live head · non-author approvals · reviewer strength grading · reviewer dispatch when CI turns green | Available |
| 6 | Policy and approvals | Which decisions agents make alone, and which need a person | Required labels · profile-based review rules · rule registry with scope and supersession · holds | Labels, profile rules: Available · Rule registry, holds: Coming soon |
| 7 | Resources and accounts | Work stays within machine and account limits | Load governor with hysteresis · worker admission · account and people profiles · worker caps | Available |
| 8 | Memory | The team's experience, with a lifecycle | Capture · index · recall · verify · supersede · expire · archive | Capture, capped index, recall, supersede with successor, archive: Available · Verify on recall, age-based expiry: Coming soon |
| 9 | Knowledge base | One registry over the team's documents | Stable IDs across stores · status per item · search that reports what it did not search | Coming soon |
| 10 | Learning and refinement | Turn incidents and corrections into changes that stick | Incident intake · proposals with a revert path · before/after measurement · escalation from note to check | Coming soon |
| 11 | Measurement | Numbers about the team itself | Load samples · per-task cost · trace IDs · regression replay | Load samples: Available · Cost, tracing, replay: Coming soon |
| 12 | Identity and isolation | Bound what any one agent can touch | Agent discovery · worktree isolation · per-agent identity · sandbox and egress checks | Discovery, worktrees: Available · Identity, sandbox: Coming soon |
| 13 | Human interface | People see the team's state and decide what only they can decide | Generated role handbook · shared mailbox · decision inbox · digests | Handbook, mailbox: Available · Inbox, digests: Coming soon |
| 14 | Substrate | Everything else stands on it | Plain files · lock-serialized atomic writes · worker logs · unified evidence history | Files, locks, logs: Available · Evidence history: Coming soon |

## What ORCH-os provides

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/orch-os-architecture-dark.svg">
    <img src="assets/orch-os-architecture-light.svg" alt="ORCH-OS architecture: agent CLIs, role lease, mailbox, task board with claims, merge gate, workers in Git worktrees" width="860">
  </picture>
</p>

The status below distinguishes commands on the current `main` branch from work still under review and future directions. “Coming soon” means not yet released.

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
| Start one non-author reviewer agent when CI is green at the PR head | `orch review watch` | Available |

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
| A unified history of task outcomes | — | Coming soon |

### Agent communication

| Feature | Command or file | Status |
|---|---|---|
| Shared entries and addressed messages with acknowledgements | `orch mailbox`, `orch msg` | Available |

### Profiles: accounts and people

| Feature | Command or file | Status |
|---|---|---|
| Design for solo and team account setups | `docs/profiles.md` | Available |
| Profile commands and review-strength rules | `orch profile`, `src/profile.ts` | Available |

### Notes lifecycle

| Feature | Command or file | Status |
|---|---|---|
| Add, search, and retire file-backed notes | `orch mem` | Available |

### Learning and refinement

| Feature | Command or file | Status |
|---|---|---|
| Suggest reusable lessons from completed work | — | Coming soon |

### Policy and approvals

| Feature | Command or file | Status |
|---|---|---|
| Require a label and current-head approval before a positive gate verdict | `orch merge-gate --label NAME` | Available |
| Select review rules from an account-and-people profile | `src/profile.ts` | Available |

### Goals and verification

| Feature | Command or file | Status |
|---|---|---|
| Check local prerequisites | `orch doctor` | Available |
| Track goals through completion checks | — | Coming soon |

### Telemetry and cost

| Feature | Command or file | Status |
|---|---|---|
| Read local load samples | `orch load` | Available |
| Record per-task cost | — | Coming soon |
| Provider-neutral capability manifests, calls and usage | `orch cap` | Coming soon |

### Agent discovery and isolation

| Feature | Command or file | Status |
|---|---|---|
| Find installed agent CLIs and place workers in separate Git worktrees | `orch agents`, `orch worker start --worktree` | Available |
| Verify agent identity and sandbox boundaries | — | Coming soon |

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

The subsystems above rest on a few invariants. Each one names the mechanism that enforces it.

| Invariant | Enforced by | Status |
|---|---|---|
| One lead at a time. A new holder increments the epoch, and a renewal from a fenced holder is refused. | `orch lease` | Available |
| One owner per task. A claimed task cannot be taken until it is released or expires. | `orch task` | Available |
| A message is data, not authority. Sender and type are stored outside the body, so a body cannot forge them. | `orch msg` | Available |
| An approval binds to a commit. Reviews count only for the PR's current head, after CI at that head. | `orch merge-gate` | Available |
| The gate reports; people merge. No `orch` command merges a PR. | `orch merge-gate` | Available |
| Reviewer strength is explicit. Each reviewer is graded against the authors (other vendor, other account, or same agent in a fresh context); with a profile set, a weaker reviewer is never substituted, the request is blocked instead. Vendors and accounts are declared, not verified. | `orch review watch`, `orch profile` | Available |
| Unknown fails closed. A missing or unrecognized risk tier is treated as high. | `orch profile` | Available |
| Protect the machine, never kill work. High load refuses new workers; running ones are left alone. | `orch load`, `orch worker start` | Available |
| Cleanup never destroys work. A worktree is removed only when Git reports nothing changed, untracked or ignored. | `orch worker stop` | Available |
| Knowledge is superseded, not deleted. Retiring a note records its successor and keeps the file. | `orch mem retire` | Available |
| Every task reaches a recorded end state; "unknown" is a state, not a guess. | Run history | Coming soon |
| The learner never grades itself. Learning cannot edit the checks it is measured against. | Learning and measurement | Coming soon |

## Documentation

- [Concepts](docs/concepts.md) — roles, leases, messages, claims, workers, and notes.
- [Commands](docs/commands.md) — subcommands, flags, exit codes, and configuration.
- [Profiles](docs/profiles.md) — design (not implemented): profiles by accounts and people, a review policy per risk tier, and the review strength each verdict reports.
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
