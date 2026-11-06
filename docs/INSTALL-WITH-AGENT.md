# Install or update ORCH-os with a coding assistant

For a coding assistant that can run commands on the user's machine. It covers two cases on macOS or Windows 11: a new install of the latest published `orch-os`, and an update of an older install to that version. It keeps an existing ORCH-os home as it is, and it does not repair, downgrade or remove anything.

When the `node` command is missing, step 1 tells the assistant how to install Node.js first. This guide has no step that replaces, upgrades or removes a Node.js that is already installed.

## Rules

- Tell the user which operating system you detected, then follow exactly one group below: **macOS** or **Windows 11**. On any other system, stop: this guide has no group for it.
- Run the steps of that group in order, one command at a time, and read each result before the next step. Step 3 decides whether this run is a **new install** or an **update**; tell the user which one, and follow the lines for that case in the later steps.
- "Stop" means: run nothing further from this guide, change nothing, and tell the user the command, its output and its exit code. Stop also when a command fails in a way its step does not name, or when its result is not one the step names.
- Run each command as written. Do not add `sudo`, `--force` or any other flag.

## macOS

1. `node --version` must print `v22` or a higher major version. If it does, go to step 2. If not, follow the one case below that matches the result; on any other result, stop.
   - **`node` is not found.** Install Node.js, in this order:
     - **Not run by the authors.** The install command below has not been run by the authors of this guide. What it installs, and every result this case names after it, is unverified until the user's machine shows it.
     - `command -v brew` must print a path. If it prints nothing, stop: tell the user to install Node.js 22 or newer from https://nodejs.org/en/download and then to paste the same sentence to the assistant again.
     - `brew install node` must exit 0. If it asks a question, do not answer it: stop and show the user the question.
     - Start a new terminal process and run `node --version` in it. If it prints `v22` or a higher major version, go to step 2. If `node` is still not found, stop: tell the user to restart the coding assistant and then to paste the same sentence to the assistant again. Do not edit `PATH` or any startup file of the shell.
   - **`node --version` prints a version lower than `v22`.** Do not install, replace or upgrade anything. Run `command -v node` and show the user that path and the version. Tell the user that other software on this machine may depend on this Node.js. Then stop, and give the user two choices: upgrade this Node.js themselves, or set up a separate Node.js 22 or newer. Tell the user to paste the same sentence to the assistant again after either one.
2. `npm view orch-os version` must exit 0 and include exactly one line that matches `^\d+\.\d+\.\d+$` with no other text on that line. Ignore lines beginning "npm notice"; ignore no other lines and do not update npm. The version number is the **latest version**; later steps compare against it. On any other result, stop.
3. `ls -d "$(npm root --global)/orch-os"` decides the case. If it fails with `No such file or directory` for a path that ends in `/node_modules/orch-os`, this is a **new install**. If it prints a path that ends in `/node_modules/orch-os`, this is an **update**. On any other result, stop.
4. `command -v orch` checks the command on `PATH`. New install: it must print nothing; if it prints a path, stop: an `orch` command from another install is already on `PATH`. Update: it must print a path; if it prints nothing, stop: the installed package has no `orch` command on `PATH`.
5. `orch --version` runs only for an update; on a new install, go to step 6. It must print `orch ` and a version. If that version is the latest version from step 2, ORCH-os is already up to date: skip step 7. If it is lower than the latest version, go on. If it is higher, or the output has another form, stop: this guide does not downgrade.
6. `ls -d "${ORCH_HOME:-$HOME/.orch}"` checks for an ORCH-os home. If it prints the directory, a home exists: keep it as it is and skip step 8. If it fails with `No such file or directory`, step 8 creates the home. On any other result, stop.
7. `npm install --global orch-os@latest` must exit 0. It replaces only the package files; it does not read or change the home from step 6.
8. `orch init --no-profile --no-handbook` runs only when step 6 found no home. It must print two `wrote` lines, for `config.toml` and `mailbox.md` in the directory from step 6, and end with `next: orch doctor`. If it prints `config exists`, stop: a home appeared after step 6.
9. `orch --version` must print `orch ` followed by exactly the latest version from step 2. If it prints another version, stop: another `orch` command on `PATH` comes before the one npm installed.
10. `orch doctor` must end with `doctor: PASS (0 required check(s) failed)`. Show the user every row. If it ends with `doctor: FAIL`, stop: this guide does not repair a failed check.

## Windows 11

**Run on Windows Server 2022, not on Windows 11.** The authors ran steps 1 to 10 of this group on Windows Server 2022 with Node.js 22 already installed, as a new install and as an update from an older ORCH-os, in Windows PowerShell under the SYSTEM account with a temporary npm prefix and home. The case in step 1 where `node` is not found was not run. On Windows 11, every expected result below is unverified until the user's machine shows it.

Use PowerShell, not as administrator.

1. `node --version` must print `v22` or a higher major version. If it does, go to step 2. If not, follow the one case below that matches the result; on any other result, stop.
   - **`node` is not found.** Install Node.js, in this order:
     - **Not run by the authors.** The install command below has not been run by the authors of this guide. What it installs, and every result this case names after it, is unverified until the user's machine shows it.
     - `Get-Command winget -ErrorAction SilentlyContinue` must print a command. If it prints nothing, stop: tell the user to install Node.js 22 or newer from https://nodejs.org/en/download and then to paste the same sentence to the assistant again.
     - `winget install --id OpenJS.NodeJS.LTS --exact --source winget` must exit 0. If it asks a question, do not answer it: stop and show the user the question.
     - Start a new PowerShell process and run `node --version` in it. If it prints `v22` or a higher major version, go to step 2. If `node` is still not found, stop: tell the user to restart the coding assistant and then to paste the same sentence to the assistant again. Do not edit `PATH` or any startup file of the shell.
   - **`node --version` prints a version lower than `v22`.** Do not install, replace or upgrade anything. Run `(Get-Command node).Source` and show the user that path and the version. Tell the user that other software on this machine may depend on this Node.js. Then stop, and give the user two choices: upgrade this Node.js themselves, or set up a separate Node.js 22 or newer. Tell the user to paste the same sentence to the assistant again after either one.
2. `npm.cmd view orch-os version` must exit 0 and include exactly one line that matches `^\d+\.\d+\.\d+$` with no other text on that line. Ignore npm notice lines beginning "npm notice" or "npm.cmd : npm notice", plus these PowerShell error-record continuation lines only when they belong to that notice: "At line:", "+ npm.cmd view orch-os version", "+ ~", "+ CategoryInfo", and "+ FullyQualifiedErrorId". Ignore no other lines and do not update npm. The version number is the **latest version**; later steps compare against it. On any other result, stop.
3. `Test-Path -LiteralPath (Join-Path (npm.cmd root --global) 'orch-os')` decides the case. If it prints `False`, this is a **new install**. If it prints `True`, this is an **update**. On any other result, stop.
4. `Get-Command orch -ErrorAction SilentlyContinue` checks the command on `PATH`. New install: it must print nothing; if it prints a command, stop: an `orch` command from another install is already on `PATH`. Update: it must print a command; if it prints nothing, stop: the installed package has no `orch` command on `PATH`.
5. `orch.cmd --version` runs only for an update; on a new install, go to step 6. It must print `orch ` and a version. If that version is the latest version from step 2, ORCH-os is already up to date: skip step 7. If it is lower than the latest version, go on. If it is higher, or the output has another form, stop: this guide does not downgrade.
6. `Test-Path -LiteralPath $(if ($env:ORCH_HOME) { $env:ORCH_HOME } elseif ($env:HOME) { Join-Path $env:HOME '.orch' } else { Join-Path $env:USERPROFILE '.orch' })` checks for an ORCH-os home. If it prints `True`, a home exists: keep it as it is and skip step 8. If it prints `False`, step 8 creates the home. On any other result, stop.
7. `npm.cmd install --global orch-os@latest` must exit 0. It replaces only the package files; it does not read or change the home from step 6.
8. `orch.cmd init --no-profile --no-handbook` runs only when step 6 found no home. It must print two `wrote` lines, for `config.toml` and `mailbox.md` in the directory from step 6, and end with `next: orch doctor`. If it prints `config exists`, stop: a home appeared after step 6.
9. `orch.cmd --version` must print `orch ` followed by exactly the latest version from step 2. If it prints another version, stop: another `orch` command on `PATH` comes before the one npm installed.
10. `orch.cmd doctor` must end with `doctor: PASS (0 required check(s) failed)`. Show the user every row. If it ends with `doctor: FAIL`, stop: this guide does not repair a failed check.

## Limits

- Step 7 installs the version that the npm `latest` tag names when it runs. Step 9 checks that it is the same version step 2 printed, so a release published between the two steps makes the guide stop instead of reporting a version it did not check.
- An update keeps the existing home: `config.toml`, `mailbox.md` and everything else in it stay as they were. The guide runs no migration; if the new version needs one, `orch doctor` in step 10 names it and the guide stops there.
- Step 8 writes no handbook files and no `[profile]` table, so `orch doctor` shows the `handbook` row as `SKIP`. A later `orch init` without flags writes the handbook files and leaves the existing `config.toml` unchanged.
- `orch init` writes `config.toml` and `mailbox.md` with a plain file write, not through a temporary file and a rename. `orch init --force` replaces `config.toml` with defaults and keeps only the `[profile]` tables of the existing file; this guide never uses it.
- The Node.js install command in step 1 of each group has not been run by the authors of this guide. Neither command names a Node.js version; step 1 checks only what `node --version` prints afterwards.
- This guide makes no claim about a downgrade, about two installs of `orch-os` under different Node.js installs, or about paths that another program changes while the steps run.
