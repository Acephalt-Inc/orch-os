# OS-A handback

## Result

The package ships 13 skill folders. `orch skills install` copies them to the workspace, with `--user`, `--only`, `--dry-run`, and backed-up `--force` behavior. `orch skills status --json` reports the package version and one state per skill. `orch init --everyday` offers the install command and writes skills only with `--with-skills`. Doctor includes an informational skills row.

## Checks

- Offline card command with a worktree-local npm cache: TypeScript passed; 3 test files passed, 17 tests passed; `npm pack --dry-run 2>&1 | grep -c "skills/away/SKILL.md"` returned `1`.
- Focused integration checks after the final rebuild: `tests/learning-registered.test.ts` 6 passed; `tests/knowledge-registered.test.ts` 5 passed. The Windows skipped-test coverage check and update-check public help snapshot each passed.
- `git diff --check` passed.
- The full `npx vitest run` was started once. It did not complete and produced no overall totals. I stopped it after roughly 20 minutes of repeated 60-second timeouts and long quiet periods. Observed failures included loopback `listen EPERM` in update tests and `private storage request refused` in private-store tests. That run also used compiled output from before the package-read and public-help fixes; the affected focused checks passed after the final rebuild. Full-suite totals remain unavailable in this sandbox.

`npm pack --dry-run` listed these skill files:

```text
skills/away/SKILL.md
skills/back/SKILL.md
skills/caffeine/SKILL.md
skills/insight/SKILL.md
skills/night-shift/SKILL.md
skills/orch-advisor/SKILL.md
skills/orch-swarm/SKILL.md
skills/product-demo-storyboard/references/source-notes.md
skills/product-demo-storyboard/SKILL.md
skills/progress/SKILL.md
skills/README.md
skills/record/SKILL.md
skills/research-library/SKILL.md
skills/serial-merge/SKILL.md
skills/sleep/SKILL.md
```

## Install transcript

```text
$ orch skills install --only away,back
away: installed
back: installed
exit 0
edited away/SKILL.md
$ orch skills install --only away,back
away: kept (modified)
back: unchanged
exit 0
$ orch skills status --json
{"version":"2.2.0","skills":[{"name":"away","state":"modified"},{"name":"back","state":"installed"},{"name":"caffeine","state":"missing"},{"name":"insight","state":"missing"},{"name":"night-shift","state":"missing"},{"name":"orch-advisor","state":"missing"},{"name":"orch-swarm","state":"missing"},{"name":"product-demo-storyboard","state":"missing"},{"name":"progress","state":"missing"},{"name":"record","state":"missing"},{"name":"research-library","state":"missing"},{"name":"serial-merge","state":"missing"},{"name":"sleep","state":"missing"}]}
exit 0
```

Mutation RED/GREEN: skipping the final shipped entry failed the completeness test, and overwriting an edited copy failed the preservation test. Both passed after restoration. Details are in `RED.md`.

Files changed: `src/skills.ts`, `src/cli.ts`, `package.json`, `skills/README.md`, `tests/skills-install.test.ts`, `tests/init.test.ts`, `tests/doctor.test.ts`, `tests/fixtures/part2-public-text.json`, `docs/windows.md`, and these two receipts.

OMITTED: Full-suite pass and totals could not be verified under the sandbox's local network and private-store restrictions. No publishing, commit, push, or external network action was performed.
