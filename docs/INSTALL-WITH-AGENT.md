# Install ORCH-os with a coding assistant

For a coding assistant that can run commands on the user's machine. It covers one case: a first install of `orch-os@2.1.0` on macOS or Windows 11. It does not upgrade, repair or remove anything.

## Rules

- Tell the user which operating system you detected, then follow exactly one group below: **macOS** or **Windows 11**. On any other system, stop: this guide has no group for it.
- Run the steps of that group in order, one command at a time, and read each result before the next step.
- "Stop" means: run nothing further from this guide, change nothing, and tell the user the command, its output and its exit code. Stop also when a command fails, or when its result is not the one the step names.
- Run each command as written. Do not add `sudo`, `--force` or any other flag.

## macOS

1. `node --version` must print `v22` or a higher major version. Otherwise stop: this package requires Node.js 22 or newer, and installing or replacing Node.js is the user's decision.
2. `npm ls --global --depth=0` must not list an `orch-os` package. If it does, stop: the package is already installed.
3. `command -v orch` must print nothing. If it prints a path, stop: an `orch` command is already on `PATH`.
4. `ls -d "${ORCH_HOME:-$HOME/.orch}"` must fail with `No such file or directory`. If it prints the directory, stop: an ORCH-os home already exists there.
5. `npm install --global orch-os@2.1.0` must exit 0.
6. `orch init --no-profile --no-handbook` must print two `wrote` lines, for `config.toml` and `mailbox.md` in the directory from step 4, and end with `next: orch doctor`. If it prints `config exists`, stop: a home already existed.
7. `orch --version` must print `orch 2.1.0`.
8. `orch doctor` must end with `doctor: PASS (0 required check(s) failed)`. Show the user every row. If it ends with `doctor: FAIL`, stop: this guide does not repair a failed check.

## Windows 11

**Unverified on Windows.** The steps in this group have not been run on a Windows machine. Every expected result below is unverified until the user's machine shows it.

Use PowerShell, not as administrator.

1. `node --version` must print `v22` or a higher major version. Otherwise stop: this package requires Node.js 22 or newer, and installing or replacing Node.js is the user's decision.
2. `npm.cmd ls --global --depth=0` must not list an `orch-os` package. If it does, stop: the package is already installed.
3. `Get-Command orch -ErrorAction SilentlyContinue` must print nothing. If it prints a command, stop: an `orch` command is already on `PATH`.
4. `Test-Path -LiteralPath $(if ($env:ORCH_HOME) { $env:ORCH_HOME } elseif ($env:HOME) { Join-Path $env:HOME '.orch' } else { Join-Path $env:USERPROFILE '.orch' })` must print `False`. If it prints `True`, stop: an ORCH-os home already exists there.
5. `npm.cmd install --global orch-os@2.1.0` must exit 0.
6. `orch.cmd init --no-profile --no-handbook` must print two `wrote` lines, for `config.toml` and `mailbox.md` in the directory from step 4, and end with `next: orch doctor`. If it prints `config exists`, stop: a home already existed.
7. `orch.cmd --version` must print `orch 2.1.0`.
8. `orch.cmd doctor` must end with `doctor: PASS (0 required check(s) failed)`. Show the user every row. If it ends with `doctor: FAIL`, stop: this guide does not repair a failed check.

## Limits

- Step 6 writes no handbook files and no `[profile]` table, so `orch doctor` shows the `handbook` row as `SKIP`. A later `orch init` without flags writes the handbook files and leaves the existing `config.toml` unchanged.
- `orch init` writes `config.toml` and `mailbox.md` with a plain file write, not through a temporary file and a rename. `orch init --force` replaces `config.toml` with defaults and keeps only the `[profile]` tables of the existing file; this guide never uses it.
- This guide makes no claim about an upgrade, about a home that already exists, or about paths that another program changes while the steps run.
