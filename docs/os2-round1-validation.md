# OS-2 Round 1 validation

Checkout: `/tmp/wt-os2`; branch `codex/os-2-required-check-gating-1007`; starting head `59d4da867c9653c47abb19309088ec96de63c120`.

## Full suite

First command: `npm test > .os2-round1-evidence/npm-test.txt 2>&1` (exit 1 in the restricted sandbox).

```text
 FAIL  tests/workers.test.ts > WorktreeV2 > a_live_pid_whose_start_time_cannot_be_read_is_never_signalled
 Test Files  1 failed | 19 passed (20)
      Tests  1 failed | 369 passed (370)
```

The unchanged worker PID-safety test needs process inspection. Its assertions were retained.

Rerun command: `npm test > .os2-round1-evidence/npm-test-process-inspection.txt 2>&1` (exit 0, process inspection enabled).

```text
> orch-os@2.0.1 test
> tsc -p tsconfig.json && vitest run
 Test Files  20 passed (20)
      Tests  370 passed (370)
   Start at  00:11:15
   Duration  34.09s (transform 170ms, setup 0ms, collect 318ms, tests 33.65s, environment 0ms, prepare 24ms)
```

## Named mutation witnesses

Each mutation was applied separately. Source and all pre-existing dist files were saved as bytes, restored in finally blocks, and byte-compared after each run. Mutation-created dist files were removed. The final npm test rebuilt the restored source.

Runner: `./node_modules/.bin/vitest run tests/required-checks.test.ts tests/required-checks-binary.test.ts -t FILTER`.

| Mutation | Filter | Change |
|---|---|---|
| (a) | `required check "SKIPPED"` | Map SKIPPED rows to SUCCESS before calling ciVerdict. |
| (b) | `only stale required success` | Replace explicit row SHA handling with `const sha = head`. |
| (c) | `review v1 two required names\|generated two required names` | Exact reviewer replacement quoted below. |
| (d) | `ambiguous required duplicate SUCCESS` | Discard a non-SUCCESS row when a same-head same-workflow/name row reports SUCCESS. |
| scope | `shared CI evaluator stays\|CLI diff contains\|packed policy stays` | Restore the review-head src/checks.ts and src/cli.ts bytes from 59d4da8. |

Exact (c) replacement:

```ts
const ci = ciAtHead(head, rows, (inp.requiredChecks ?? []).slice(0, rows.filter(r => r.workflow != null && r.workflow !== "").length || undefined));
```

### Mutation a: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'required check "SKIPPED" alongside un…': packed merge-gate and review watch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'required check "SKIPPED" alongside un…': gate and actual dispatch
 Test Files  2 failed (2)
      Tests  2 failed | 112 skipped (114)
```

### Mutation b: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'only stale required success alongside…': packed merge-gate and review watch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'only stale required success alongside…': gate and actual dispatch
 Test Files  2 failed (2)
      Tests  2 failed | 112 skipped (114)
```

### Mutation c: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'review v1 two required names with one…': packed merge-gate and review watch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'review v1 two required names with one…': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > generated two required names block one listed workflow in both requirement orders
 Test Files  2 failed (2)
      Tests  3 failed | 2 passed | 109 skipped (114)
```

### Mutation d: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > 'ambiguous required duplicate SUCCESS …': packed merge-gate and review watch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > 'ambiguous required duplicate SUCCESS …': gate and actual dispatch
 Test Files  2 failed (2)
      Tests  20 failed | 94 skipped (114)
```

### Mutation scope: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > packed policy stays in mergegate without an out-of-scope checks module
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > shared CI evaluator stays in the allowed mergegate module
 FAIL  tests/required-checks.test.ts > RequiredChecksPolicy > CLI diff contains only required-check command plumbing
 Test Files  2 failed (2)
      Tests  3 failed | 111 skipped (114)
```

### Mutation pack: exit 1

```text
 FAIL  tests/required-checks-binary.test.ts > RequiredChecksPackedBinary > npm pack is offline, disables the notifier, and isolates developer credentials
 Test Files  1 failed (1)
      Tests  1 failed | 53 skipped (54)
```

For the pack mutation, only the guarded spawnSync call was replaced with the original call quoted in tests/required-checks-binary.test.ts. The local registry observer recorded `GET /npm`; it never forced the update notifier on. The restored offline invocation recorded zero requests in the passing full suite.

## Scope status

Policy and configuration validation now live in src/mergegate.ts; src/checks.ts is removed. Review watch imports that evaluator. CLI retains only six added and three modified lines against receipt base 41b86f7, for config plumbing and --require-check registration. The two-file production allowlist cannot accommodate that flag registration while preserving its existing tests. A user decision on the minimal CLI exception is pending; finding 3 is not claimed closed.

No pre-OS-2 test file or snapshot was changed. The existing required-check scenario assertions remain; the generated matrix adds two-name requirements and increases from 26,200 to 52,400 combinations.
