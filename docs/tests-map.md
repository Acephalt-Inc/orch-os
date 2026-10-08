# Test map: v1.1 Python suite to v2 vitest suite

Every one of the 59 Python tests in v1.1 (`python3 -m unittest discover -s tests`) has a vitest test with the same class and test name in v2. `tests/tests-map.test.ts` checks every row of this table: 59 rows, each naming a vitest `describe`/`it` pair that exists and has the Python class and test name.

Notes on the port:

- `test_concurrent_posts_lose_nothing` used 40 threads in one Python process. Node runs one thread per process, so the v2 test starts 10 separate processes that post 4 entries each (40 total). That tests the lock across processes, which is harder than the original.
- `test_install.py` tested the Python installer; `install.test.ts` runs the same 7 scenarios against the rewritten `install.sh`, which installs the built Node package.
- Python `assertRaises(ValueError)` became `toThrow(RangeError)` (mailbox) and `WorkerError` stays `WorkerError`.

| # | v1.1 Python test | v2 vitest test |
|---|---|---|
| 1 | `tests/test_lease.py` `LeaseTest.test_acquire_then_status` | `tests/lease.test.ts` `LeaseTest > test_acquire_then_status` |
| 2 | `tests/test_lease.py` `LeaseTest.test_unexpired_holder_blocks_other_acquire` | `tests/lease.test.ts` `LeaseTest > test_unexpired_holder_blocks_other_acquire` |
| 3 | `tests/test_lease.py` `LeaseTest.test_force_takeover_bumps_epoch` | `tests/lease.test.ts` `LeaseTest > test_force_takeover_bumps_epoch` |
| 4 | `tests/test_lease.py` `LeaseTest.test_expired_lease_is_acquirable` | `tests/lease.test.ts` `LeaseTest > test_expired_lease_is_acquirable` |
| 5 | `tests/test_lease.py` `LeaseTest.test_short_duration_is_raised_to_minimum` | `tests/lease.test.ts` `LeaseTest > test_short_duration_is_raised_to_minimum` |
| 6 | `tests/test_lease.py` `LeaseTest.test_renew_rules` | `tests/lease.test.ts` `LeaseTest > test_renew_rules` |
| 7 | `tests/test_lease.py` `LeaseTest.test_release_then_other_acquires` | `tests/lease.test.ts` `LeaseTest > test_release_then_other_acquires` |
| 8 | `tests/test_mailbox.py` `MailboxTest.test_post_and_read_order` | `tests/mailbox.test.ts` `MailboxTest > test_post_and_read_order` |
| 9 | `tests/test_mailbox.py` `MailboxTest.test_rejects_unknown_section_and_empty` | `tests/mailbox.test.ts` `MailboxTest > test_rejects_unknown_section_and_empty` |
| 10 | `tests/test_mailbox.py` `MailboxTest.test_concurrent_posts_lose_nothing` | `tests/mailbox.test.ts` `MailboxTest > test_concurrent_posts_lose_nothing` |
| 11 | `tests/test_mailbox.py` `MailboxTest.test_body_cannot_forge_markers_or_headers` | `tests/mailbox.test.ts` `MailboxTest > test_body_cannot_forge_markers_or_headers` |
| 12 | `tests/test_mailbox.py` `MailboxTest.test_rejects_author_with_spaces` | `tests/mailbox.test.ts` `MailboxTest > test_rejects_author_with_spaces` |
| 13 | `tests/test_mergegate.py` `MergeGateTest.test_approved_at_head_passes` | `tests/mergegate.test.ts` `MergeGateTest > test_approved_at_head_passes` |
| 14 | `tests/test_mergegate.py` `MergeGateTest.test_approval_of_older_commit_is_stale` | `tests/mergegate.test.ts` `MergeGateTest > test_approval_of_older_commit_is_stale` |
| 15 | `tests/test_mergegate.py` `MergeGateTest.test_author_approval_never_counts` | `tests/mergegate.test.ts` `MergeGateTest > test_author_approval_never_counts` |
| 16 | `tests/test_mergegate.py` `MergeGateTest.test_changes_requested_blocks_even_with_approval` | `tests/mergegate.test.ts` `MergeGateTest > test_changes_requested_blocks_even_with_approval` |
| 17 | `tests/test_mergegate.py` `MergeGateTest.test_later_approval_replaces_changes_requested` | `tests/mergegate.test.ts` `MergeGateTest > test_later_approval_replaces_changes_requested` |
| 18 | `tests/test_mergegate.py` `MergeGateTest.test_dismissed_clears_and_commented_is_ignored` | `tests/mergegate.test.ts` `MergeGateTest > test_dismissed_clears_and_commented_is_ignored` |
| 19 | `tests/test_mergegate.py` `MergeGateTest.test_ci_red_and_no_checks_block` | `tests/mergegate.test.ts` `MergeGateTest > test_ci_red_and_no_checks_block` |
| 20 | `tests/test_mergegate.py` `MergeGateTest.test_required_approvals_threshold` | `tests/mergegate.test.ts` `MergeGateTest > test_required_approvals_threshold` |
| 21 | `tests/test_mergegate.py` `MergeGateTest.test_label_is_off_by_default_and_enforced_when_set` | `tests/mergegate.test.ts` `MergeGateTest > test_label_is_off_by_default_and_enforced_when_set` |
| 22 | `tests/test_mergegate.py` `MergeGateTest.test_bad_head_blocks` | `tests/mergegate.test.ts` `MergeGateTest > test_bad_head_blocks` |
| 23 | `tests/test_mergegate.py` `MergeGateTest.test_explicit_head_override_makes_approval_stale` | `tests/mergegate.test.ts` `MergeGateTest > test_explicit_head_override_makes_approval_stale` |
| 24 | `tests/test_mergegate.py` `MergeGateTest.test_duplicate_check_names_cannot_hide_a_failure` | `tests/mergegate.test.ts` `MergeGateTest > test_duplicate_check_names_cannot_hide_a_failure` |
| 25 | `tests/test_mergegate.py` `MergeGateTest.test_expected_head_guard_blocks_when_pr_moved` | `tests/mergegate.test.ts` `MergeGateTest > test_expected_head_guard_blocks_when_pr_moved` |
| 26 | `tests/test_load.py` `LoadTest.test_levels` | `tests/load.test.ts` `LoadTest > test_levels` |
| 27 | `tests/test_load.py` `LoadTest.test_needs_two_samples_up_three_down` | `tests/load.test.ts` `LoadTest > test_needs_two_samples_up_three_down` |
| 28 | `tests/test_load.py` `LoadTest.test_temp_command_is_optional_and_parsed` | `tests/load.test.ts` `LoadTest > test_temp_command_is_optional_and_parsed` |
| 29 | `tests/test_load.py` `LoadTest.test_real_sample_is_portable` | `tests/load.test.ts` `LoadTest > test_real_sample_is_portable` |
| 30 | `tests/test_workers.py` `WorkersTest.test_start_list_stop` | `tests/workers.test.ts` `WorkersTest > test_start_list_stop` |
| 31 | `tests/test_workers.py` `WorkersTest.test_high_load_blocks_start_unless_forced` | `tests/workers.test.ts` `WorkersTest > test_high_load_blocks_start_unless_forced` |
| 32 | `tests/test_workers.py` `WorkersTest.test_bad_name_and_missing_command` | `tests/workers.test.ts` `WorkersTest > test_bad_name_and_missing_command` |
| 33 | `tests/test_workers.py` `WorkersTest.test_stop_refuses_a_reused_pid` | `tests/workers.test.ts` `WorkersTest > test_stop_refuses_a_reused_pid` |
| 34 | `tests/test_detect.py` `DetectTest.test_nothing_installed` | `tests/detect.test.ts` `DetectTest > test_nothing_installed` |
| 35 | `tests/test_detect.py` `DetectTest.test_path_hit_uses_absolute_path_and_template` | `tests/detect.test.ts` `DetectTest > test_path_hit_uses_absolute_path_and_template` |
| 36 | `tests/test_detect.py` `DetectTest.test_non_executable_is_ignored` | `tests/detect.test.ts` `DetectTest > test_non_executable_is_ignored` |
| 37 | `tests/test_detect.py` `DetectTest.test_fallback_dir_found_off_path` | `tests/detect.test.ts` `DetectTest > test_fallback_dir_found_off_path` |
| 38 | `tests/test_detect.py` `DetectTest.test_fallback_can_be_disabled` | `tests/detect.test.ts` `DetectTest > test_fallback_can_be_disabled` |
| 39 | `tests/test_detect.py` `DetectTest.test_preference_order` | `tests/detect.test.ts` `DetectTest > test_preference_order` |
| 40 | `tests/test_detect.py` `InitDoctorTest.test_fresh_machine_without_agents_is_green` | `tests/detect.test.ts` `InitDoctorTest > test_fresh_machine_without_agents_is_green` |
| 41 | `tests/test_detect.py` `InitDoctorTest.test_init_writes_detected_agents_and_default` | `tests/detect.test.ts` `InitDoctorTest > test_init_writes_detected_agents_and_default` |
| 42 | `tests/test_detect.py` `InitDoctorTest.test_init_agent_flag_picks_default` | `tests/detect.test.ts` `InitDoctorTest > test_init_agent_flag_picks_default` |
| 43 | `tests/test_detect.py` `InitDoctorTest.test_init_unknown_agent_is_refused_and_writes_nothing` | `tests/detect.test.ts` `InitDoctorTest > test_init_unknown_agent_is_refused_and_writes_nothing` |
| 44 | `tests/test_detect.py` `InitDoctorTest.test_init_keeps_existing_config_until_force` | `tests/detect.test.ts` `InitDoctorTest > test_init_keeps_existing_config_until_force` |
| 45 | `tests/test_detect.py` `InitDoctorTest.test_doctor_flags_configured_agent_that_disappeared` | `tests/detect.test.ts` `InitDoctorTest > test_doctor_flags_configured_agent_that_disappeared` |
| 46 | `tests/test_detect.py` `InitDoctorTest.test_agents_command_lists_known_and_custom` | `tests/detect.test.ts` `InitDoctorTest > test_agents_command_lists_known_and_custom` |
| 47 | `tests/test_detect.py` `InitDoctorTest.test_worker_start_with_agent_feeds_task_on_stdin` | `tests/detect.test.ts` `InitDoctorTest > test_worker_start_with_agent_feeds_task_on_stdin` |
| 48 | `tests/test_cli.py` `CliTest.test_doctor_fails_before_init_passes_after` | `tests/cli.test.ts` `CliTest > test_doctor_fails_before_init_passes_after` |
| 49 | `tests/test_cli.py` `CliTest.test_malformed_config_is_a_clean_error` | `tests/cli.test.ts` `CliTest > test_malformed_config_is_a_clean_error` |
| 50 | `tests/test_cli.py` `CliTest.test_init_is_idempotent` | `tests/cli.test.ts` `CliTest > test_init_is_idempotent` |
| 51 | `tests/test_cli.py` `CliTest.test_lease_mailbox_merge_gate_roundtrip` | `tests/cli.test.ts` `CliTest > test_lease_mailbox_merge_gate_roundtrip` |
| 52 | `tests/test_cli.py` `CliTest.test_worker_options_after_name_and_command_after_dashdash` | `tests/cli.test.ts` `CliTest > test_worker_options_after_name_and_command_after_dashdash` |
| 53 | `tests/test_install.py` `InstallTest.test_from_checkout` | `tests/install.test.ts` `InstallTest > test_from_checkout` |
| 54 | `tests/test_install.py` `InstallTest.test_piped_with_explicit_repo` | `tests/install.test.ts` `InstallTest > test_piped_with_explicit_repo` |
| 55 | `tests/test_install.py` `InstallTest.test_explicit_repo_beats_a_checkout_in_the_cwd` | `tests/install.test.ts` `InstallTest > test_explicit_repo_beats_a_checkout_in_the_cwd` |
| 56 | `tests/test_install.py` `InstallTest.test_piped_via_gh_when_logged_in` | `tests/install.test.ts` `InstallTest > test_piped_via_gh_when_logged_in` |
| 57 | `tests/test_install.py` `InstallTest.test_private_repo_without_gh_login_fails_with_a_hint` | `tests/install.test.ts` `InstallTest > test_private_repo_without_gh_login_fails_with_a_hint` |
| 58 | `tests/test_install.py` `InstallTest.test_no_source_is_a_clear_error` | `tests/install.test.ts` `InstallTest > test_no_source_is_a_clear_error` |
| 59 | `tests/test_install.py` `InstallTest.test_rerun_keeps_config` | `tests/install.test.ts` `InstallTest > test_rerun_keeps_config` |

## Tests added in v2

These cover the new features and the compatibility guarantees. Run `npx vitest list` for the current list.

| File | Covers |
|---|---|
| `tests/lock.test.ts` | TOML keys that would reach `Object.prototype` are rejected; mkdir lock: mutual exclusion across 6 processes, stale-lock recovery, timeout, lost-lock detection, release on exception, a leftover v1.1 `.lock` file; the TOML reader; Python-compatible JSON layout |
| `tests/lease.test.ts` (`LeaseV2`) | an unreadable lease file fails closed, release fenced by `--expected-epoch`, v1.1 lease file layout, reading a lease written by v1.1, corrupt file reads as free |
| `tests/mailbox.test.ts` (`MailboxV2`) | v1.1 timestamp format, reading a mailbox written by v1.1, posts in the same millisecond keep their order, bodies with `\r` / U+2028 / U+2029 cannot forge entries, CRLF files read and post, `-n 0` behaviour |
| `tests/mergegate.test.ts` (`MergeGateV2`) | render text identical to v1.1, malformed PR data fails closed, workflow names and status contexts, fixture list |
| `tests/load.test.ts` (`LoadV2`) | state file layout and history cap, unknown stored tier |
| `tests/workers.test.ts` (`WorktreeV2`) | worktree create / attach / clean removal / dirty keep / ignored-files keep / group members that ignore SIGTERM killed before the worktree is touched / members left after the leader exited (list, start refusal, stop) / a PID file of 1 or less, or a live pid whose start time cannot be read, never signalled / non-numeric limits create nothing / option smuggling via `--base` and `--branch` / `--keep-worktree` / existing branch / `--base` / refusals |
| `tests/cli.test.ts` (`CliV2`) | `mailbox read` escapes control characters in timestamps and bodies, a bad config value is one doctor FAIL row, non-numeric config durations exit 2, usage errors exit 2, help, version, lease JSON key order, merge-gate BLOCKED paths, stdin bodies, exit codes of the built binary |
| `tests/review.test.ts` | review comments: counted only at the head sha and from a non-author agent (every past task holder, case-insensitive, including a 3-holder hand-off chain and task files written before the holder list), CHANGES/REJECT after APPROVE blocks, sources do not cross, malformed first lines (warned on stderr), fail closed without a task author, threshold/label/CI/head guard; the default `github` source reproduces the v2.0.1 CLI output byte for byte (`tests/snapshots/`); `orch review` posting through a fake `gh`; more than 1 MiB of `gh` output; a task file whose `holders` list omits its current holder still counts that holder as an author |
| `tests/msg.test.ts` | addressed messages, kinds, ANSWER needs a QUESTION, per-reader cursor and ack, case-insensitive names, injection (including rendered output with `\r`, C1 controls, bidi marks, U+2028 and escape sequences), torn lines, a torn tail and a foreign last line, concurrent senders, `msg` CLI, `msg watch` |
| `tests/task.test.ts` | exclusive claims, case-insensitive ids (stray upper-case files ignored by `list`), epoch fencing, expiry takeover, list, validation, 8 processes racing for one task, CLI exit codes |
| `tests/mem.test.ts` | file + frontmatter + index, search, retire keeps the file, successor rules, index cap warning, injection, CLI |
| `tests/profile.test.ts` | profiles: the 12 rows of the policy table copied from `docs/profiles.md`, worker caps, a degrade never yields `auto`, the three degrade rules, strength grading (same account, cross-account, cross-vendor, unmapped reviewer or author, hand-off authors, several approvals), tier choice and globs, `--auto` authority, teammate approval (listed, stale, not listed, PR author, solo), the design's example output lines, config validation, the table writer (unrelated tables and comments kept, idempotent, appended, split tables, verbatim block) |
| `tests/profile-cli.test.ts` | with no `[profile]`: merge-gate (96 cases, both review sources), `init` output and config, and doctor rows match `tests/snapshots/merge-gate-pre-profiles.json`, captured from the release before profiles; `--tier`/`--auto` exit 2; `files` joins the `gh` field list only with path rules. `init --compute/--people`, the terminal questions (fake terminal), `--no-profile`, `--force` keeps the profile; `profile show` text and JSON; `profile update` keeps every other byte, `--dry-run`, invalid updates write nothing; doctor profile rows; merge-gate strength lines and JSON; the worker cap |
| `tests/review-watch.test.ts` | `review watch`: CI green / pending / failed / none at the head and a green older commit never counting, `require_ci = false`; reviewer choice in the six profile cells (A and D: labelled single-agent review; B, C, E, F: BLOCKED when only the author's account is available), a degraded profile, no profile; the author (every holder, any case) never chosen; missing commands; one dispatch per head, posted-line check, a new head re-dispatches, a silent reviewer goes stale (doctor row, `--force`); dry run starts and writes nothing (fake host); config validation; the CLI (`--task`, exit codes, loop, timeout, doctor rows only when configured); the worker environment and prompt on stdin |
| `tests/required-checks.test.ts` | shared CI evaluator through both merge review sources and actual `watchOnce` dispatch calls: every OS-F1 round-3 scenario-table row and 52,400 generated combinations (including two required names in both orders) with no watch-green/gate-red verdict; missing, skipped, neutral, cancelled, pending, stale and conflicting duplicate required checks; partial/unreadable/blank/conflicting workflow joins; the review-v1 two-requirement/one-workflow mutation witness in both orders; allowed policy-module placement and minimal CLI plumbing; no bypass through `require_ci = false` or `--force`; retained literal status-context matching and no-requirements output (with `SKIPPED` and with `NEUTRAL`); bare and qualified job-name case sensitivity; the `head_sha` fixture alias |
| `tests/required-checks-binary.test.ts` | `npm pack` runs offline with the update notifier disabled, isolated empty npm configs and scrubbed credentials; a local registry observer catches the original pack-call mutation; packing builds in a disposable source copy seeded with retired outputs (shared helper `tests/_pack.ts`), never in the checkout, and extracts the distributable, then drives its `dist/cli.js`: every scenario fixture through both merge review sources and watch's real `gh` adapter; exit codes, messages, no worker/state files for blocked heads, timeout, live merge path, partial and unreadable workflow lists (including partial stdout on HTTP 403), two required names with one listed workflow in both orders, 250 workflow rows with pagination arguments, a required suite listed only after workflow row 200 (fake `gh` accepts only the exact status and workflow-run `--jq` expressions), additive `--require-check` including two distinct flags, every unmet name in text and JSON with the unknown-workflow sentence, malformed config/flag exit 2 |
| `tests/tests-map.test.ts` | this table: every v1.1 row names an existing vitest test |
| `tests/init.test.ts` | handbook files (flat and skills layouts), keep vs `--force-handbook`, template frontmatter, a v1.1 config without the new tables, `orch config` |
| `tests/package-pack.test.ts` | real tarball excludes retired outputs and runs its CLI; build removes residue and tolerates missing dist; packing disposable copies preserves checkout dist paths and bytes |
