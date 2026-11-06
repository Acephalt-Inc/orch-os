# Set up Claude Code

Quick start with Node.js 22 or newer:

```sh
npx orch-os setup
```

If you installed the package globally, use `orch setup`. Run it from the workspace folder, or give `--workspace PATH`. The folder must already exist. Setup asks for the folder, a preset (`coding`, `research`, or `ops`), the destination (`workspace` or `user`), and whether to install the background service. Press Enter for the current folder, `coding`, `workspace`, and no background service.

```sh
orch setup --workspace "./my project" --preset coding --scope workspace --yes
orch setup --workspace "./my project" --preset research --scope user --dry-run
```

`--yes` accepts these defaults without questions. It leaves the optional background service off; run interactive setup to select it. Without a terminal, setup prints its plan and exits with code 2 unless you give `--yes` or `--dry-run`. A dry run prints all five installation commands and their status checks. It runs no subcommands, creates no folders, and writes no files.

Setup runs these steps in order, using the commands in your installed build:

| Step | Command | What it provides |
|---|---|---|
| 1 | `orch init --no-profile` | Local config, mailbox, and role handbook; keeps an existing profile |
| 2 | `orch lead install --workspace PATH --host claude` | Lead instructions and a Claude bootstrap file |
| 3 | `orch host install --workspace PATH --host claude --preset PRESET --scope SCOPE` | Claude permissions and hooks for the selected preset |
| 4 | `orch service install` | Optional background service |
| 5 | `orch skills install --host claude --scope SCOPE` | Bundled assistant skills |

All commands run with the workspace as their working folder, including skills installation. The lead pack stays in that workspace. Scope selects the host settings and skills destination; it does not relocate ORCH config or the background service. Those commands use the normal ORCH home (`ORCH_HOME`, otherwise `~/.orch`). Setup does not choose a merge policy, review strength, or worker limit; configure a profile separately if you need one.

Each step reports `DONE`, `SKIPPED` (already installed or service declined), `UNAVAILABLE` (command missing or no platform adapter), or `FAILED` with the installer's reason. Missing commands do not prevent other steps from running. Some package builds contain only init and lead installation; setup names the missing capabilities rather than claiming they were installed. Installing a newer build and rerunning setup makes newly included commands available.

On a rerun, setup asks the installers for their status and skips verified installations. With `--yes` and no `--preset`, it keeps the installed host preset; an explicit different preset stops with instructions to uninstall the host integration and rerun setup. The service installer checks ownership even when a job is already loaded. Setup writes no completion markers and never uses force or edits installed files itself. A conflict or edited installation may require attention; existing files remain under the individual installer's protection. A failed step stops all later steps, explains which step blocked them, and exits with code 1. Fix its reason and rerun with the same options. Unavailable capabilities alone are exit code 0.

The same plan runs on macOS and Windows, using native paths and Node child processes without a shell. A platform adapter reports its own availability and reason; setup does not infer support from the OS name. Automated tests cover both path styles and fake adapter results. Real Windows execution has not been verified for this command.

The lead bootstrap uses the workspace `CLAUDE.md`. The host working agreement uses `.claude/CLAUDE.md`, so each installer can track its own changes.

After setup, open Claude Code in the workspace and say **"boot the lead"**. Setup installs local integration; it does not sign you into Claude Code or verify that a live assistant has loaded the files. The summary ends with a `Claude Code:` line: `found` with the path of the `claude` command (looked up as `orch agents` does), or `NOT FOUND` with the install link. It does not change the exit code.
