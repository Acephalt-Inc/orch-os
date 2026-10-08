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
| `tests/lock.test.ts` | TOML keys that would reach `Object.prototype` are rejected; mkdir lock: mutual exclusion across 6 processes, dead-local/old-foreign/ownerless refusal and quiescent reset, old-live-local refusal, corrupt/unreadable owner refusal before callback, a dangling `owner.json` symlink, timeout, what a waiter reports in seven schedules at the timeout edge, the built CLI's one-line cleanup failure, lost-token/unknown-owner refusal before effect and after temporary-file preparation, lost-lock detection, release on exception, a leftover v1.1 `.lock` file; the TOML reader; Python-compatible JSON layout |
| `tests/lease.test.ts` (`LeaseV2`) | an unreadable lease file fails closed, release fenced by `--expected-epoch`, v1.1 lease file layout, reading a lease written by v1.1, damaged lease blocks every action, explicit epoch-7-to-8 recovery, journal/evidence preservation, missing or damaged epoch-floor refusal, dangling symlinks, epoch exhaustion, record-before-lease crash injection, recovery crash after rename, lost-token refusal before either store, a read-back whose epoch differs |
| `tests/mailbox.test.ts` (`MailboxV2`) | v1.1 timestamp format, reading a mailbox written by v1.1, posts in the same millisecond keep their order, bodies with `\r` / U+2028 / U+2029 cannot forge entries, CRLF files read and post, `-n 0` behaviour |
| `tests/mergegate.test.ts` (`MergeGateV2`) | render text identical to v1.1, malformed PR data fails closed, workflow names and status contexts, fixture list |
| `tests/load.test.ts` (`LoadV2`) | state file layout and history cap, unknown stored tier |
| `tests/workers.test.ts` (`WorktreeV2`) | worktree create / attach / clean removal / dirty keep / ignored-files keep / group members that ignore SIGTERM killed before the worktree is touched / members left after the leader exited (list, start refusal, stop) / a PID file of 1 or less, or a live pid whose start time cannot be read, never signalled / non-numeric limits create nothing / option smuggling via `--base` and `--branch` / `--keep-worktree` / existing branch / `--base` / refusals |
| `tests/cli.test.ts` (`CliV2`) | `mailbox read` escapes control characters in timestamps and bodies, a bad config value is one doctor FAIL row, non-numeric config durations exit 2, usage errors exit 2, help, version, lease JSON key order, merge-gate BLOCKED paths, stdin bodies, exit codes of the built binary; built CLI corrupt lease/task refusals and journaled recovery, unknown lock owner refusal, epoch reservation before failed publication, real SIGSTOP holder versus a contender, rejected late snapshot after simulated historical takeover |
| `tests/review.test.ts` | review comments: counted only at the head sha and from a non-author agent (every past task holder, case-insensitive, including a 3-holder hand-off chain and task files written before the holder list), CHANGES/REJECT after APPROVE blocks, sources do not cross, malformed first lines (warned on stderr), fail closed without a task author, threshold/label/CI/head guard; the default `github` source reproduces the v2.0.1 CLI output byte for byte (`tests/snapshots/`); `orch review` posting through a fake `gh`; more than 1 MiB of `gh` output; a task file whose `holders` list omits its current holder still counts that holder as an author |
| `tests/msg.test.ts` | addressed messages, kinds, ANSWER needs a QUESTION, per-reader cursor and ack, case-insensitive names, injection (including rendered output with `\r`, C1 controls, bidi marks, U+2028 and escape sequences), torn lines, a torn tail and a foreign last line, concurrent senders, `msg` CLI, `msg watch` |
| `tests/task.test.ts` | exclusive claims, case-insensitive ids (stray upper-case files ignored by `list`), epoch fencing, expiry takeover, list, validation, 8 processes racing for one task, CLI exit codes, corrupt/unreadable claim refusal for every action, explicit recovery preserving epochs and past authors, unknown-floor refusal, six CLI recoverers producing one winner and one journal |
| `tests/mem.test.ts` | file + frontmatter + index, search, retire keeps the file, successor rules, index cap warning, injection, CLI |
| `tests/profile.test.ts` | profiles: the 12 rows of the policy table copied from `docs/profiles.md`, worker caps, a degrade never yields `auto`, the three degrade rules, strength grading (same account, cross-account, cross-vendor, unmapped reviewer or author, hand-off authors, several approvals), tier choice and globs, `--auto` authority, teammate approval (listed, stale, not listed, PR author, solo), the design's example output lines, config validation, the table writer (unrelated tables and comments kept, idempotent, appended, split tables, verbatim block) |
| `tests/profile-cli.test.ts` | with no `[profile]`: merge-gate (96 cases, both review sources), `init` output and config, and doctor rows match `tests/snapshots/merge-gate-pre-profiles.json`, captured from the release before profiles; `--tier`/`--auto` exit 2; `files` joins the `gh` field list only with path rules. `init --compute/--people`, the terminal questions (fake terminal), `--no-profile`, `--force` keeps the profile; `profile show` text and JSON; `profile update` keeps every other byte, `--dry-run`, invalid updates write nothing; doctor profile rows; merge-gate strength lines and JSON; the worker cap |
| `tests/review-watch.test.ts` | `review watch`: CI green / pending / failed / none at the head and a green older commit never counting, `require_ci = false`; reviewer choice in the six profile cells (A and D: labelled single-agent review; B, C, E, F: BLOCKED when only the author's account is available), a degraded profile, no profile; the author (every holder, any case) never chosen; missing commands; one dispatch per head, posted-line check, a new head re-dispatches, a silent reviewer goes stale (doctor row, `--force`); dry run starts and writes nothing (fake host); config validation; the CLI (`--task`, exit codes, loop, timeout, doctor rows only when configured); the worker environment and prompt on stdin |
| `tests/tests-map.test.ts` | this table: every v1.1 row names an existing vitest test; every name in the ownership witness table below exists in the test group it is listed under |
| `tests/init.test.ts` | handbook files (flat and skills layouts), keep vs `--force-handbook`, template frontmatter, a v1.1 config without the new tables, `orch config` |

## OS-3 ownership witnesses (single local host)

| Promise | Tests |
|---|---|
| Damaged ownership never reads free | `OwnershipSafety > damaged_lease_blocks_every_action`, `TaskOwnershipSafety > corrupt_claim_blocks_claim_renew_release_status_and_history`, `OwnershipCli > built_cli_refuses_damage_names_the_file_and_recovers_epoch_7_to_8` |
| Recovery keeps the epoch floor and evidence | `OwnershipSafety > explicit_recovery_uses_epoch_7_record_and_journals`, `recovery_without_an_epoch_floor_refuses_without_moving_evidence`, `bad_epoch_record_never_resets_even_for_a_valid_lease`, `dangling_symlink_is_unknown`, `epoch_exhaustion_refuses_before_writing` |
| Recovery journal records are fsynced before close | `OwnershipSafety > recovery_fsyncs_each_journal_record_before_closing_it` |
| Lease and epoch temporary files are fsynced before publication | `OwnershipSafety > lease_and_epoch_temporary_files_are_fsynced_before_publication` |
| Lease, epoch and task files use mode 0600 | `OwnershipSafety > lease_epoch_and_task_files_are_mode_0600` |
| Read-back verifies both the caller's session and issued epoch | `OwnershipSafety > a_read_back_with_another_session_but_the_issued_epoch_is_unverified`, `a_read_back_with_the_callers_session_but_another_epoch_is_unverified` |
| A lost lock stops recovery before the journal is opened, before a journal line is appended and before the damaged file is renamed | `OwnershipSafety > every_recovery_effect_checks_lock_ownership` |
| Reservation precedes publication, even on a crash | `OwnershipSafety > a_crash_before_lease_publication_reserves_the_epoch_first`, `recovery_crash_after_rename_does_not_restart_or_reuse_the_reserved_epoch`, `OwnershipCli > cli_publication_failure_reserves_the_epoch_before_effect` |
| Paused local owners cannot be aged out; late writes cannot change the target | `LockV2 > an_old_live_local_pid_is_never_stale_by_age`, `lost_or_unknown_owner_rejects_atomic_write_before_effect`, `ownership_is_rechecked_after_preparing_the_temporary_file`, `a_lost_token_rejects_direct_message_append_before_effect`, `LockRecovery > paused_live_owner_is_never_reclaimed`, `OwnershipSafety > lost_lock_rejects_lease_and_epoch_store_before_effect`, `OwnershipCli > a_real_paused_holder_is_safe_and_a_late_write_is_fenced` |
| Unknown lock owner blocks callbacks | `LockV2 > unknown_owner_blocks_before_the_callback`, `a_dangling_owner_symlink_is_unknown_not_missing`, `EACCES_owner_read_preserves_ownership_and_never_runs_callback`, `OwnershipCli > unreadable_lock_owner_blocks_cli_even_with_recover`, `unknown_owner_blocks_other_protected_cli_operations` |
| Tasks recover explicitly and retain known authors | `TaskOwnershipSafety > task_recovery_is_explicit_monotonic_journaled_and_preserves_authors`, `unreadable_task_blocks_every_operation_and_requires_explicit_recovery`, `task_recovery_without_a_surviving_floor_never_restarts_at_one`, `concurrent_cli_recoverers_have_one_winner_and_one_journal`, `OwnershipCli > built_task_cli_requires_explicit_journaled_recovery_and_lists_damage` |
| Owner-only lock release; owner publication precedes work; death requires a stopped-process reset | `LockRecovery > paused_live_owner_is_never_reclaimed`, `dead_owner_or_initializer_is_refused_until_reset`, `LockV2 > abandoned_locks_require_quiescent_reset`, `mutual_exclusion_across_processes`, `owner_record_is_published_before_acquire_returns` |
| Cleanup failures reach the library and built CLI; callback errors are preserved | `LockRecovery > cleanup_error_is_nonzero_and_names_residual_state`, `built_cli_prints_a_cleanup_failure_as_one_orch_line_and_exits_1`, `callback_and_cleanup_errors_are_both_reported`, `failed_initialization_releases_only_its_own_directory_without_entering_callback` |
| Ownerless/unknown/legacy artifacts block with named paths and reset instructions | `LockRecovery > unknown_owner_and_legacy_artifacts_block` |
| At the timeout a waiter reports only what it saw: a released lock is tried once more and is never called abandoned | `LockRecovery > the_timeout_edge_reports_only_what_the_waiter_saw` |
| A stored lease is reported only when the read-back shows the caller's session and the issued epoch | `OwnershipSafety > a_read_back_with_the_callers_session_but_another_epoch_is_unverified` |

`TestsMapV2 > every_ownership_witness_in_the_map_names_an_existing_test` checks that each name in this table exists in the group it is listed under.

Known lock limit: no automatic dead-lock recovery. Stop every `orch` process and disable new launches before removing the exact named lock directory; preserve lease, epoch, author and journal files. Existing data `--recover` paths do not reset locks. Death/reset schedules use built modules, real children, readiness acknowledgments and awaited termination; ordering does not depend on fixed sleeps. The paused initializer schedule retains the initializer plus two contenders from the former breaker witness; both contenders now refuse; a successor acquires only after owner release. The timeout-edge schedules are forced by hooks on `mkdir`, the owner read and the directory listing inside one child process, not by real contention. Data-layer crash-injection tests remain injected failures, not power-loss evidence.
