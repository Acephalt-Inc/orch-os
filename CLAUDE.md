# Install ORCH-os for the user (instructions for the coding agent)

Follow this file when the user asks you to install ORCH-os, or gives you only this repository's URL. If the user is working on the ORCH-os code itself, this file does not apply.

You are a coding agent (Claude Code, Codex or similar) and the user wants ORCH-os installed. Users of this guide are often not programmers: do every step yourself, explain nothing technical unless they ask, and only stop for something they must do with their own hands (a password, an installer window, a sign-in).

Rules:
- Run one step at a time and check its result as the step says before going on.
- A step is done only when its check passes. If a check fails and the step does not say how to fix it, stop and tell the user, in plain words, which step failed and the exact error text.
- Never use `sudo`, `--force` or administrator PowerShell. Never edit shell startup files or `PATH` yourself.
- Never run `orch setup` inside the ORCH-os source folder. It is run in a separate workspace folder (step 6).

## 1. Detect the system

Run `uname -s`. `Darwin` means macOS: use the **macOS** commands below. If `uname` is not found, run `$PSVersionTable.PSVersion` in PowerShell; if that prints a version, this is Windows: use the **Windows** commands, in PowerShell (not as administrator). Any other system: tell the user this guide covers macOS and Windows only, and stop.

Tell the user in one line which system you found.

## 2. Node.js 22 or newer

Check: `node --version` prints `v22` or a higher major version. If it does, go to step 3.

If `node` is missing or older than v22:
- **macOS with Homebrew** (`command -v brew` prints a path): `brew install node`. If Node is already from Homebrew but old, `brew upgrade node`.
- **macOS without Homebrew**: download the official installer and open it:
  ```sh
  cd ~/Downloads
  PKG=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/\.pkg$/{print $2}')
  curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$PKG" && open "$PKG"
  ```
  Tell the user: "A Node.js installer window opened. Click Continue and Install, enter your Mac password when asked, then tell me when it says the installation was successful."
- **Windows**: `winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements`. If `winget` is not found, tell the user to install Node.js LTS from https://nodejs.org (the "Windows Installer (.msi)" button), and wait for them.

Check again in a **new** terminal process (Windows: a new PowerShell). The installer changes `PATH` only for new processes. On Windows, if `node` is still not found, run `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')` in the same PowerShell and check again. If it still fails, ask the user to restart the agent and say "continue the ORCH-os install".

On Windows, always type `npm.cmd` and `orch.cmd` instead of `npm` and `orch`: PowerShell may refuse the `.ps1` versions.

## 3. Get the source

If you are already inside a clone of this repository (`package.json` has `"name": "orch-os"`), use that folder. Otherwise clone it into the home folder (add `--branch <name>` if the user named a branch):

- macOS: `git clone https://github.com/Acephalt-Inc/orch-os.git ~/orch-os-src && cd ~/orch-os-src`
- Windows: `git clone https://github.com/Acephalt-Inc/orch-os.git "$HOME\orch-os-src"; cd "$HOME\orch-os-src"`

If `git` is missing, download the source archive instead (replace `main` with the branch name if one was given):
- macOS: `mkdir -p ~/orch-os-src && curl -fsSL https://github.com/Acephalt-Inc/orch-os/archive/refs/heads/main.tar.gz | tar -xz --strip-components 1 -C ~/orch-os-src && cd ~/orch-os-src`
- Windows: `Invoke-WebRequest -UseBasicParsing https://github.com/Acephalt-Inc/orch-os/archive/refs/heads/main.zip -OutFile "$HOME\orch-os-src.zip"; Expand-Archive "$HOME\orch-os-src.zip" "$HOME\orch-os-src" -Force; cd (Get-ChildItem "$HOME\orch-os-src" -Directory | Select-Object -First 1).FullName`

Check: `package.json` in the current folder contains `"name": "orch-os"`.

## 4. Build and install from the source

macOS:
```sh
npm ci && npm run build && npm pack
npm install --global "./$(ls orch-os-*.tgz | tail -1)"
```
Windows (PowerShell does not expand `*` for npm, so resolve the file name first):
```powershell
npm.cmd ci; npm.cmd run build; npm.cmd pack
$tgz = (Get-ChildItem orch-os-*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
npm.cmd install --global "$tgz"
```
Each command must exit 0. `npm install --global` may print a warning about install scripts or `allowScripts`; ignore it.

If `npm install --global` fails with `EACCES` on macOS, Node.js was installed into a system folder: do not use `sudo`. Tell the user and install Node with Homebrew instead (step 2), then repeat step 4.

Check, in a new terminal process: `orch --version` (Windows: `orch.cmd --version`) prints `orch 2.3.0` or later, and `orch setup --help` prints a line starting `usage: orch setup`.

Once `npm view orch-os version` prints `2.3.0` or later, `npm install --global orch-os` installs the same version from npm. Until then, install from the source as above.

## 5. Claude Code

ORCH-os sets up Claude Code. Check: `claude --version` prints a version. If it does not, tell the user that Claude Code is needed to use ORCH-os, give them https://claude.com/claude-code, and continue with step 6; setup still works and Claude Code can be installed afterwards.

## 6. Set up a workspace

Ask the user which folder they want to work in. If they have no preference, use a new folder `orch-workspace` in their home folder (macOS: `mkdir -p ~/orch-workspace && cd ~/orch-workspace`; Windows: `New-Item -ItemType Directory -Force "$HOME\orch-workspace"; cd "$HOME\orch-workspace"`). It must not be the source folder from step 3.

Run `orch setup --yes` (Windows: `orch.cmd setup --yes`) in that folder.

Check: it exits 0, and no line under `Setup summary:` says `FAILED` (each setup line says `DONE` or `SKIPPED`; the `Claude Code:` line is covered by step 5). A `FAILED` line, or exit code 1, means setup is not done: read its reason, fix it if the reason names a fix, and run the same command again. If it still fails, tell the user the reason.

## 7. Health check

Run `orch doctor` (Windows: `orch.cmd doctor`).

Check: the last line is `doctor: PASS`. `SKIP` rows are fine. If it ends with `doctor: FAIL`, the `FAIL` rows name what is missing: fix what you can with the steps above and run it again; otherwise tell the user which row failed.

## 8. Tell the user

In two to four short, plain sentences, with no jargon:
- ORCH-os is installed (give the version from step 4) and set up in the folder from step 6.
- To use it: open Claude Code in that folder and say "boot the lead".
- To check it later: run `orch doctor` (Windows: `orch.cmd doctor`).
If Claude Code was missing in step 5, say that they need to install it first and give the link.
