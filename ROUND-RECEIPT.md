# Round receipt — weekly auto-update recut (a)

- Base: `72f99820d085d14f15baadb9d904feae14e5526d`.
- Scope: check-only switch, validated state, status, notice, ISO-week lock and entry trigger. Installation and rollback checks are deferred to PR (b).
- Required behavior was absent at base (there was no `src/update-auto.ts` and the packed-contract assertion rejected any such module). The packed contract is changed only as authorized by A1 and retains an explicit scan prohibiting npm execution.
- Defect witnesses: ISO week arithmetic uses week-start elapsed intervals rather than `year * 53`; notice recovery atomically renames the pathname and verifies the stale token before deleting; public path metadata renders basename only; docs promise config.toml-only future backup.
- Coverage: untrusted-input (strict state shape and surrogate rejection); list-completeness (literal three-item allowlist); partial-read (invalid/truncated JSON is due); auth (NA, public unauthenticated registry); concurrency (O_EXCL interval lock and token claim); off-switch (four action boundaries); global-state (only updater files under ORCH_HOME); removed-behavior (no installation or ORCH_NO_AUTO_UPDATE).
- roster: no subagents
- parent_direct: implementation was completed directly because delegation was not requested.
