# ORCH-os on Windows

Windows 10 and 11 with Node.js 22 or newer. No POSIX shell and no Git installation are needed for the commands listed under "What works".

## Install

```powershell
npm i -g orch-os
orch init
orch doctor
```

`npm` puts three files named `orch` in its global folder: `orch.cmd` (used by cmd.exe), `orch.ps1` (used by PowerShell) and a shell script. If PowerShell answers `running scripts is disabled on this system`, that is the Windows execution policy refusing `orch.ps1` (it refuses `npm.ps1` the same way). Either type `orch.cmd` instead of `orch`, use cmd.exe, or allow local scripts for your user once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

`install.sh` is a POSIX shell installer and is not used on Windows.

## What works

`orch --version`, `init`, `doctor`, `config`, `agents`, `lease`, `mailbox`, `msg`, `task`, `mem`, `profile`, `merge-gate` (fixtures, and live mode with the GitHub CLI) and `review approve|changes|reject`.

The CI job `windows` runs the test suite on `windows-latest`, and then `scripts/e2e-install.ps1` in Windows PowerShell: `npm pack`, `npm install -g` of that tarball, and `orch --version`, `init`, `doctor`, `load`, `mem add` and `mem search`, `task claim` and `release`, `msg send` and `msg read`, `lease acquire`, `status` and `release`, each with its exit code checked. On Windows the check also requires `load` to print `load_ratio=n/a`, `swap=n/a` and `temp=n/a`. Cleanup runs after normal completion and caught failures: failure to remove the package fails the check, and temporary-folder removal is attempted.

## What is not available

- `orch worker start`, `orch worker stop` and `orch review watch` exit 2 with `Windows support for workers and review watch is not available yet.` Workers rely on POSIX process groups and signals.
- `orch load` reports `load_ratio=n/a swap=n/a temp=n/a`: Windows has no load average, and `[load] temp_command` is a shell command line. The tier stays `NORMAL`.
- In PowerShell, a `--` on the command line is consumed by PowerShell before `orch.ps1` sees it. Nothing that works on Windows needs `--`.

## What differs

- **`orch doctor`.** The platform row reads `windows (no process groups)`. `git` is a `SKIP` row when it is absent, not a `FAIL`: only worker worktrees use git. The `timeout (worker time limit)` row is always `SKIP`: the `timeout.exe` that Windows ships waits for a key press and is not a time limit.
- **Paths in output.** Paths under `ORCH_HOME` are printed with the home as Windows writes it and a `/` before the last part, for example `C:\Users\me\.orch/mailbox.md`. Windows accepts both separators.
- **Files in use.** Some Windows sharing modes can refuse a rename while another process has the file, or a file inside the directory, open. `orch` retries Windows `EPERM`, `EACCES` and `EBUSY` rename errors for up to about two seconds before reporting the error. Tests inject these errors to verify the retry policy on every host; the native held-open-file tests record the behavior actually observed by the Windows CI runner.
- **Agent discovery.** `orch init` and `orch agents` look for agent CLIs on `PATH` and then in per-user folders only: `%USERPROFILE%\.local\bin`, `%USERPROFILE%\.claude\local` and `%APPDATA%\npm`. `ORCH_AGENT_DIRS` is separated with `;`.

## How programs are found and started

These rules apply on Windows only; macOS and Linux behave as before.

- A program is looked up on `PATH` (and, for agent CLIs, the folders above). The current folder is never searched. A command name containing `/` or `\` is accepted only when it is a full path with a drive (`C:\tools\program`) or a network share (`\\server\share\program`). A `PATH` or `ORCH_AGENT_DIRS` entry must be fully qualified too. Relative forms such as `.`, `tools`, `sub/program`, `\tools` and `C:tools` are not searched.
- Only `.com`, `.exe`, `.bat` and `.cmd` files count as programs. `PATHEXT` decides the order among those four; the script types it also lists by default (`.vbs`, `.js`, `.wsf` and others) are ignored.
- `gh` is started by the full path found this way. A bare name would make Windows look in the current folder first.
- A `.bat` or `.cmd` file cannot be started directly. It is started through `cmd.exe` (by full path) with delayed expansion off and one fixed command line in which every argument is quoted and every cmd.exe special character is escaped. cmd.exe ends a command at a line break, so an argument that contains one is refused with a message instead of being cut short. This matters only if `gh` on your machine is a `.cmd` file: `orch review ... -m TEXT` then fails with that message. The `gh.exe` that the GitHub CLI installs is started directly and has no such limit.

## Not covered on Windows

The `windows` CI job runs every test file. The tests below are skipped there, each with `skipIf(process.platform === "win32")` in the test file: 15 `skipIf` markers, 41 tests. `tests/windows-portability.test.ts` checks that every marker is named on this page.

| Test file | Skipped | Why |
|---|---|---|
| `tests/workers.test.ts` | all of `WorkersTest` (4): `test_start_list_stop`, `test_high_load_blocks_start_unless_forced`, `test_bad_name_and_missing_command`, `test_stop_refuses_a_reused_pid` | workers are not available on Windows |
| `tests/workers.test.ts` | all of `WorktreeV2` (14): `start_creates_a_worktree_on_its_own_branch_and_runs_there`, `stop_removes_a_clean_worktree_and_keeps_the_branch`, `stop_keeps_a_dirty_worktree`, `stop_keeps_a_worktree_that_holds_only_ignored_files`, `stop_kills_group_members_that_ignore_sigterm_before_touching_the_worktree`, `stop_reaches_members_left_behind_after_the_leader_exited`, `non_numeric_worker_limits_are_config_errors`, `base_and_branch_cannot_smuggle_git_options`, `a_live_pid_whose_start_time_cannot_be_read_is_never_signalled`, `a_pid_file_of_1_or_less_is_never_signalled`, `an_existing_worktree_is_attached_and_never_removed`, `existing_branch_is_checked_out_and_base_is_honoured`, `refuses_non_repo_foreign_dir_bad_branch_and_branch_without_worktree`, `keep_worktree_flag_keeps_even_a_clean_one` | worker worktrees: workers are not available on Windows |
| `tests/cli.test.ts` | `test_worker_options_after_name_and_command_after_dashdash` | starts a worker |
| `tests/detect.test.ts` | `test_worker_start_with_agent_feeds_task_on_stdin` | starts a worker |
| `tests/profile-cli.test.ts` | all of `ProfileWorkers` (1): `worker_start_refuses_at_the_written_limit_and_force_overrides` | starts workers |
| `tests/review-watch.test.ts` | all of `ReviewWatchCli` (5): `cli_needs_a_task_a_pr_number_and_a_profile_for_tier`, `cli_dry_run_prints_the_reviewer_and_command_and_starts_nothing`, `cli_loop_waits_for_ci_dispatches_and_stops_when_reviewed`, `cli_loop_timeout_exits_1`, `doctor_lists_review_agents_only_when_configured` | `orch review watch` is refused on Windows. The last one asserts that doctor prints no `review watch` text, and the Windows platform row names review watch; its review-agent row is tested on every system by `doctor lists a review agent row only when one is configured` |
| `tests/review-watch.test.ts` | all of `ReviewWatchDispatch` (1): `worker_start_passes_the_review_environment_and_the_prompt_on_stdin` | a review dispatch starts a worker |
| `tests/review-watch.test.ts` | all of `ReviewWatchWorkerLimit` (1): `a_review_dispatch_is_refused_at_the_written_worker_limit` | a review dispatch starts a worker |
| `tests/required-checks-binary.test.ts` | `250 workflow runs join through the paginated API contract`, `required suite appears only after workflow row 200` | they only call `orch review watch` |
| `tests/install.test.ts` | all of `InstallTest` (7): `test_from_checkout`, `test_piped_with_explicit_repo`, `test_explicit_repo_beats_a_checkout_in_the_cwd`, `test_piped_via_gh_when_logged_in`, `test_private_repo_without_gh_login_fails_with_a_hint`, `test_no_source_is_a_clear_error`, `test_rerun_keeps_config` | `install.sh` is the POSIX shell installer; on Windows the install is `npm i -g`, which `scripts/e2e-install.ps1` runs |
| `tests/load.test.ts` | `test_temp_command_is_optional_and_parsed` | `temp_command` is a shell command line |
| `tests/load.test.ts` | `test_real_sample_is_portable` | it expects a numeric load average; Windows has none and `orch load` reports `n/a`, which `doctor passes its Windows platform row and load reports unavailable signals` tests |
| `tests/review.test.ts` | `review_command_posts_the_review_line` | the stand-in `gh` is a `.cmd` file on Windows and the test posts a body with line breaks, which cmd.exe cannot carry. `a review comment goes through a gh.cmd; a body with a line break is refused with the reason` covers the Windows behaviour |
| `tests/windows-portability.test.ts` | `POSIX lookup still needs the execute bit` | a Windows file system has no execute bit to leave unset |

Five more tests run on Windows without their `orch review watch` or `orch worker start` part; everything else in them runs:

| Test file | Test | Left out on Windows |
|---|---|---|
| `tests/required-checks-binary.test.ts` | `$title: packed merge-gate and review watch` (one per scenario) | the `review watch` calls after the two `merge-gate` calls |
| `tests/required-checks-binary.test.ts` | `live merge gate and watch both block the incomplete workflow-run list` | the `review watch` call after the live `merge-gate` call |
| `tests/required-checks-binary.test.ts` | `text and JSON name every unmet requirement and explain unknown workflow` | the two `review watch` calls after the `merge-gate` calls |
| `tests/required-checks-binary.test.ts` | `malformed config %s exits 2 in both commands` (one per value) | the `review watch` command of the two |
| `tests/profile-cli.test.ts` | `a_profile_written_for_the_removed_table_is_refused_by_every_command_that_reads_it` | the `worker start` and `review watch` commands of the five: on Windows they are refused before the profile is read |

Not exercised by any automated check on Windows: typing a message or note body at an interactive console (the tests and the CI job pass bodies with `-m` or through a pipe), and a machine where PowerShell's execution policy blocks `orch.ps1`.
