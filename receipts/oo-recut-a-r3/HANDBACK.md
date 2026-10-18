# r3 handback

- before: `77509b1bd901daa065fa125fb2a99dafc64a1161`
- after: this handback commit (`git rev-parse HEAD`)
- roster: no subagents
- parent_direct: user required a single constrained fix round

## F1 acceptance mapping

| Rows | Named tests |
|---|---|
| A01-A07 | `A01 update off writes the exact off marker`; `A02 update on removes the off marker`; `A03 missing marker defaults the effective switch on`; `A04 ORCH_AUTO_UPDATE=0 turns the effective switch off`; `A05 status reports never when state is absent`; `A06 status reports next due at last check plus seven days`; `A07 pins the complete literal allowlist` |
| A08 | `A08 agents schedules once`; `A08 lease status schedules once`; `A08 doctor schedules once` |
| A10, A12-A16 | `A10 first permitted check makes exactly one registry request`; `A12 exactly seven days is due`; `A13 numeric 7 is due`; `A14 null is due`; `A15 a last check two days in the future is due`; `A16 only one caller acquires the current weekly lock` |
| A17-A21 | `A17 keeps a two-interval-old lock`; `A18 deletes a three-interval-old lock`; `A19 names a 2021-01-01 lock with ISO year 2020 week 53`; `A20 keeps week 2020-53 two intervals later`; `A21 deletes week 2020-52 three intervals later` |
| A22-A24, A26 | `A22 reclaims a stale claim whose token remains A`; `A23 preserves fresh B installed before stale rename`; `A24 release preserves a replacement holder B`; `A26 a claim is available after the documented stale age` |
| A27-A31 | `A27 wrong-shape state is treated as due and rewritten`; `A28 list state is treated as due and rewritten`; `A29 scalar state is treated as due and rewritten`; `A30 truncated state is treated as due and rewritten`; `A31 lone-surrogate state is treated as due and rewritten` |
| A33-A35 | `A33 stable patch queues a notice`; `A34 stable minor queues a notice`; `A35 major queues a notice`; `A35 prerelease queues a notice`; `A35 zero-major minor queues a notice` |
| A46, A49-A50 | `A46 status redacts POSIX and Windows backup paths`; `A49 auto-update docs defer config.toml-only backup`; `A50 the public manifest pins the auto-update paragraph` |

Witness coverage is retained by the existing update-check, learning and network suites. Authentication is N/A for the public unauthenticated registry. The tests cover malformed/untrusted state, complete allowlist membership, cadence, concurrency claims, off switch, global-state isolation and no-install packed behavior.

## F2-F4

- F2: no line exceeds 110 columns in `src/update-auto.ts`, the owned `src/cli.ts` entry block, or `tests/update-auto.test.ts`.
- F3: allowlist classification now precedes the conditional import and home/environment access. Excluded commands call `main()` without loading the updater.
- F4: only the first network-sentence test's expected derivation was extended with the weekly commands. The other six test bodies are unchanged.

## Gates

Focused final:

```text
Test Files  4 passed (4)
     Tests  81 passed (81)
```

The full run was stopped after known environment-sensitive cases failed; it did not reach a final summary. Observed failures included `posix_directory_admission_checks_opened_object`, `missing_path_file_permission_and_malicious_bytes_refused`, and three knowledge probe cases. A focused replay of those environment cases reported `Test Files 3 failed (3)` and `Tests 5 failed | 44 passed (49)`; the owned focused suites were green.

## Counts against 72f9982

Production: `src/update-auto.ts` 220 additions; `src/cli.ts` 35 additions + 1 deletion = 256 counted lines. Tests remain below 480 counted lines and docs remain below 20 counted lines. See final `git diff --numstat 72f9982`.
