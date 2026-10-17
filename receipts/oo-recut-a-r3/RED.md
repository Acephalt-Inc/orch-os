# r3 RED

Base: `77509b1bd901daa065fa125fb2a99dafc64a1161`

Initial focused run used Node v22.22.2 and a UUID-free `TMPDIR`.

- F3 RED: `tests/learning-registered.test.ts:218`: `expected [ [], [], [], [], [ 'ORCH_HOME' ] ] to deeply equal [ [], [], [], [], [] ]`.
- F4 RED: `tests/network-sentence.test.ts:130`: `expected [ 'agents', 'doctor', …(9) ] to deeply equal [ 'load', 'merge-gate', …(6) ]`.

The pre-existing five update-auto tests were green at r2. The expanded named acceptance cases were added in this round. They exercise existing r2 behavior and were green-at-r2 except for the entry-hook and network derivation defects above; no production assertion failed while adding them.
