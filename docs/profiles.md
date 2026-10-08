# Adaptive profiles: accounts × people (design)

**Status: design only. Nothing in this document is implemented yet.** It describes a later code change. It builds on PR #4 (comment review gate), which is still open; where this design depends on that PR, the dependency is named, and its final form may change the details below.

## 1. The problem

ORCH-os has one merge rule today: CI green, `required_approvals` non-author approvals at the PR's current head, no changes requested, an optional label. The same rule applies whether you are:

- one person with one agent CLI account, where the "reviewer" is another session on the same account and the same model;
- one person with several accounts, where a reviewer can run on a separate quota, or on a different vendor's model;
- a small team, where a human teammate can review and approve.

These setups can give very different review strength, and they need different defaults:

| Setup | What goes wrong with one fixed rule |
|---|---|
| One account | The gate can pass on a review that only a second session of the same model produced. Nothing says how weak that review is. |
| Several accounts | Nothing uses the stronger review that is available, and nothing tells low-risk changes (fine to merge automatically) from high-risk ones (a person should decide). |
| Several vendors | A different-vendor reviewer catches mistakes a same-model reviewer shares with the author, but the gate cannot require one for high-risk changes. |
| Team | A teammate's approval is the strongest review there is, but the gate treats it like any other approval and cannot require it for high-risk changes. |

A **profile** records which setup you have. A **policy function** turns the profile and a PR's risk tier into three requirements: which reviewer is needed, who may merge, and how many workers may run at once. Every merge-gate verdict then states the **review strength actually achieved**. When a setup lacks what a rule needs, the feature that depends on it turns off and `orch doctor` says so. The gate never reports a stronger review than it saw.

## 2. The two axes and the six cells

**Compute** is the agent accounts you run agents on:

| Value | Meaning |
|---|---|
| `one` | One account on one agent CLI (for example Claude Code or Codex CLI). Every agent shares one quota. |
| `same-vendor` | Two or more accounts, all on the same agent CLI. Each account has its own quota, but the model family is the same. |
| `multi-vendor` | Accounts on two or more different agent CLIs. |

**People** is who can approve a merge:

| Value | Meaning |
|---|---|
| `solo` | One person. That person is the only human who can decide a merge. |
| `team` | One or more teammates, each with their own GitHub account, who can approve on GitHub. |

The six cells:

| Cell | Compute · people | Lanes | Reviewer | Merge authority |
|---|---|---|---|---|
| A | one · solo | 1 lead + 1 worker, taking turns on one quota | A fresh-context session on the same account. Labelled **single-agent review**, the weakest kind. | You (the owner) decide and merge by hand. |
| B | same-vendor · solo | Lead on account 1, workers on the other accounts, in parallel | An agent on a different account: independent quota, same model family | Low risk: automatic after the review note. High risk: you decide. |
| C | multi-vendor · solo | Workers sized to the quota you have | Low risk: another account. High risk: a reviewer from a different vendor. | As B |
| D | one · team | As A | As A, plus a teammate | A teammate's GitHub approval |
| E | same-vendor · team | As B | An agent first, plus a teammate on high risk | Low risk: automatic after the agent's review note. High risk: a teammate's GitHub approval. |
| F | multi-vendor · team | As C | A different-vendor agent review, plus a teammate on high risk | As E |

The cell letters are for reading this document. The config and the CLI use the two axis values; `orch profile show` prints the letter too.

**Risk tier.** Every PR is `low` or `high`. You choose the tier (`orch merge-gate PR --tier high`), or a path rule in the profile chooses it (a PR that touches a listed path is `high`). If neither decides, the tier is `default_tier`, which is `high` unless you change it. Section 5 gives the order.

## 3. The `[profile]` table in `config.toml`

The profile lives in the existing config file, `$ORCH_HOME/config.toml` (default `~/.orch/config.toml`), as one `[profile]` table and two sub-tables. It uses only syntax the built-in TOML reader already supports: tables, dotted table headers, strings, integers and arrays. No config file without a `[profile]` table changes meaning (section 8).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `[profile] compute` | string | required | `one`, `same-vendor` or `multi-vendor` |
| `[profile] people` | string | required | `solo` or `team` |
| `[profile] lead_account` | string | the only account, if there is one | Account id the lead runs on. Workers use the others. |
| `[profile] default_tier` | string | `high` | Tier when neither `--tier` nor a path rule decides |
| `[profile] high_paths` | array of strings | `[]` | Glob patterns (`*`, `**`). A PR that changes any matching file is `high`. |
| `[profile] teammates` | array of strings | `[]` | GitHub logins whose approving review counts as a human review |
| `[profile] max_workers` | integer | `0` | Worker cap. `0` = derived from the cell (section 5). |
| `[profile] workers_per_account` | integer | `2` | Used when `max_workers = 0` in cells B, C, E, F |
| `[profile.accounts] ID = VENDOR` | string → string | none | Each account id, and its vendor: an agent CLI name as `orch agents` prints it (`claude`, `codex`, `gemini`, `qwen`, or a custom `[agents.NAME]`) |
| `[profile.agents] NAME = ID` | string → string | none | Which account each reviewing or authoring agent runs on. NAME is the name that appears on reviews: the agent name in a review comment (PR #4 (comment review gate)), or the GitHub login when the review source is `github`. |

Account ids are labels you choose. ORCH-os never reads credentials and cannot see which login an agent CLI is using, so the `accounts` and `agents` maps are **declared, not verified**. Like the comment review gate, this is a process gate between cooperating agents, not a security boundary.

Validation (a violation is a config error: exit 2 with a one-line message, as for other config keys today):

- `compute` and `people` hold one of the listed values; `default_tier` is `low` or `high`.
- Every value in `[profile.agents]` is a key of `[profile.accounts]`.
- `lead_account`, when set, is a key of `[profile.accounts]`.
- `max_workers` and `workers_per_account` are integers ≥ 0.

A declared `compute` that the `accounts` table does not back up (for example `same-vendor` with only one account listed) is **not** a config error. It is a missing capability, handled by the degrade rules in section 7.

### Examples

Cell A, one person, one account:

```toml
[profile]
compute = "one"
people = "solo"

[profile.accounts]
main = "claude"

[profile.agents]
lead = "main"
w1 = "main"
r1 = "main"
```

Cell B, one person, two accounts on the same agent CLI, migrations always high risk:

```toml
[profile]
compute = "same-vendor"
people = "solo"
lead_account = "acct1"
high_paths = ["migrations/**", ".github/workflows/**"]

[profile.accounts]
acct1 = "codex"
acct2 = "codex"

[profile.agents]
lead = "acct1"
w1 = "acct2"
w2 = "acct2"
r1 = "acct1"
```

Here `w1` writes on `acct2` and `r1` reviews on `acct1`, so `r1` gives a cross-account review of `w1`'s PR.

Cell F, a team of two, accounts on two agent CLIs:

```toml
[profile]
compute = "multi-vendor"
people = "team"
lead_account = "c1"
default_tier = "high"
high_paths = ["src/auth/**", "infra/**"]
teammates = ["octo-teammate"]

[profile.accounts]
c1 = "claude"
c2 = "claude"
x1 = "codex"

[profile.agents]
lead = "c1"
w1 = "c2"
w2 = "c2"
rx = "x1"
```

## 4. CLI surface

| Command | Does |
|---|---|
| `orch init` | On a terminal (stdin is a TTY) with no existing config, asks two questions after detection: "How many agent accounts do you run agents on: one, several on one CLI, several across CLIs?" and "Solo, or with teammates?" The detected agent CLIs pre-fill the vendor choices and the first account. It then writes `[profile]`. When stdin is not a TTY, it asks nothing and writes no `[profile]`, exactly as today. |
| `orch init --compute VALUE --people VALUE` | Same, without the questions. Either flag alone is a usage error (exit 2). |
| `orch init --no-profile` | Skip the questions on a TTY; write no `[profile]`. |
| `orch init --force` | Rewrites `config.toml` from defaults as today, but keeps an existing `[profile]` table as it was. |
| `orch profile show [--json]` | Prints the cell letter, both axes, the accounts and agents maps, the teammates, the policy for `low` and `high` (reviewer needed, merge authority, worker cap), and every missing capability (section 7). Without a `[profile]` it prints `profile: not set (merge gate uses the plain rule)` and exits 0. |
| `orch profile update [--compute V] [--people V] [--account ID=VENDOR]… [--remove-account ID]… [--agent NAME=ID]… [--remove-agent NAME]… [--teammate LOGIN]… [--remove-teammate LOGIN]… [--high-path GLOB]… [--remove-high-path GLOB]… [--default-tier low\|high] [--max-workers N] [--dry-run]` | Changes only the `[profile]` tables and leaves every other line of `config.toml` byte-for-byte as it was. It validates the result before writing (exit 2, nothing written, on a bad result) and prints `profile show` afterwards. `--dry-run` prints the new table without writing. Creating a profile when none exists needs both `--compute` and `--people`. |
| `orch merge-gate PR [--tier low\|high] [--auto]` | With a `[profile]`: applies the policy (section 5) and prints the strength line (section 6). `--tier` sets the tier. `--auto` means "the caller will merge automatically on PASS": the gate then passes only when the merge authority is `auto`. Without a `[profile]`, `--tier` and `--auto` are usage errors (exit 2), so a script cannot believe a policy was applied when none was. |
| `orch worker start …` | With a `[profile]`: refuses (exit 2) when the running workers already reach the worker cap, the same way it refuses under a blocking load tier. Attended `--force` overrides it and requires a terminal on stdin. |
| `orch doctor` | With a `[profile]`: one extra row per profile check (section 7). |

Writing the profile needs a small table writer, because `toml.ts` only reads. It should replace the `[profile]`, `[profile.accounts]` and `[profile.agents]` sections as whole blocks of text (from the header to the next header), not re-render the file. That is how every other line stays byte-identical.

## 5. The policy function

```ts
type Compute = "one" | "same-vendor" | "multi-vendor";
type People = "solo" | "team";
type Tier = "low" | "high";
type Strength = "single-agent" | "cross-account" | "cross-vendor"; // ordered, weakest first
type Authority = "auto" | "owner" | "teammate";

interface Policy {
  cell: "A" | "B" | "C" | "D" | "E" | "F";
  needAgent: Strength;       // weakest agent review that satisfies the rule
  needTeammate: boolean;     // a teammate's GitHub approval at the head is also required
  authority: Authority;      // who may perform the merge once the gate passes
  workerCap: number;         // most workers running at once
}

function policy(p: { compute: Compute; people: People; accounts: number; workersPerAccount: number;
                     maxWorkers: number }, tier: Tier): Policy;
```

`policy` is a pure function, like `evaluate()` in `mergegate.ts`. It gets the **effective** compute value, after the degrade rules in section 7, never the declared one.

### Decision table

| Cell | Tier | `needAgent` | `needTeammate` | `authority` |
|---|---|---|---|---|
| A one · solo | low | single-agent | no | owner |
| A one · solo | high | single-agent | no | owner |
| B same-vendor · solo | low | cross-account | no | auto |
| B same-vendor · solo | high | cross-account | no | owner |
| C multi-vendor · solo | low | cross-account | no | auto |
| C multi-vendor · solo | high | cross-vendor | no | owner |
| D one · team | low | single-agent | yes | teammate |
| D one · team | high | single-agent | yes | teammate |
| E same-vendor · team | low | cross-account | no | auto |
| E same-vendor · team | high | cross-account | yes | teammate |
| F multi-vendor · team | low | cross-vendor | no | auto |
| F multi-vendor · team | high | cross-vendor | yes | teammate |

Meaning of `authority`:

- `auto`: automation may merge on PASS. This is the only authority under which `merge-gate --auto` can pass.
- `owner`: PASS means the review rule is met. A person still decides, and merges by hand. `merge-gate --auto` gives BLOCKED.
- `teammate`: the gate itself requires a teammate's approval (`needTeammate`), so a PASS already carries the human decision. `merge-gate --auto` gives BLOCKED all the same: the teammate who approved, or you, performs the merge.

Worker cap (`workerCap`), when `max_workers = 0`:

| Cells | Cap |
|---|---|
| A, D | 1. The lead and one worker take turns on one quota. |
| B, C, E, F | `workers_per_account` × (number of accounts other than `lead_account`), at least 1 |

A `max_workers` above 0 replaces the derived cap in every cell.

### How the tier is chosen

In order; the first rule that decides wins:

1. `merge-gate --tier low|high`.
2. `high_paths`: if any changed file matches any pattern, the tier is `high`. Path rules can only raise the tier, never lower it; a `--tier low` given on purpose still wins.
3. `default_tier` (default `high`).

Path rules need the PR's changed files. In live mode the gate adds `files` to the `gh pr view --json` field list, but only when `high_paths` is not empty. If the file list cannot be read, the tier is `high`.

The verdict prints where the tier came from: `tier=high(flag)`, `tier=high(path: migrations/0042.sql)` or `tier=high(default)`.

## 6. Review strength achieved

The gate already decides which approvals count: at the current head, not by the author, latest per reviewer, not blocked by a later "changes requested". PR #4 (comment review gate) adds review comments, where the author is the task holder in `orch task`. The profile does not change which approvals count. It grades the ones that do.

For each counting agent approval:

| Condition | Grade |
|---|---|
| The reviewer or the author is not in `[profile.agents]` | `single-agent (unmapped)`. Unknown counts as weakest. |
| Same account as the author | `single-agent` |
| Different account, same vendor | `cross-account` |
| Different vendor | `cross-vendor` |

The author is the PR's author in `github` mode, or the task holder (plus the holder before a hand-off) in comments mode. When there are several author agents, the reviewer is compared with each one and the **weakest** result holds: a reviewer who shares an account with any author is not independent of that author.

**Achieved agent strength** is the strongest grade among the counting approvals, or `none`.

**Teammate approval** is a GitHub review with state `APPROVED` at the current head, by a login listed in `teammates`, and not by the PR's author login. Its value is `approved`, `missing`, or `n/a` in a solo profile. In comments mode, this needs both GitHub reviews and review comments in one fetch. That depends on PR #4 (comment review gate): its current form reads only comments in comments mode, and it ignores GitHub approvals there.

A PR passes when every existing rule passes **and** achieved ≥ `needAgent` **and** (not `needTeammate` or teammate = `approved`) **and** (not `--auto` or authority = `auto`).

### Output

Without a `[profile]`, the output is today's output with no change. With one, a single line goes between the existing summary line and the verdict:

```text
#101 head=1a2b3c4d5 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=C tier=high(path: infra/dns.tf) review=cross-account needed=cross-vendor teammate=n/a authority=owner
=> BLOCKED (review strength cross-account is below cross-vendor)
```

```text
#102 head=9f8e7d6c5 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=B tier=low(flag) review=cross-account needed=cross-account teammate=n/a authority=auto
=> PASS
```

```text
#103 head=0a1b2c3d4 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=A tier=high(default) review=single-agent needed=single-agent teammate=n/a authority=owner
=> PASS (single-agent review only; the owner decides the merge)
```

When a degrade rule applied (section 7), the line ends with `degraded=<reason>` and the verdict names the missing capability.

`--json` adds one object, `profile`, to the existing result: `{cell, declared_cell, tier, tier_source, achieved, needed, teammate, need_teammate, authority, worker_cap, degraded: [...]}`. Existing keys keep their names and meaning.

## 7. Fail-closed and degrade rules

Two principles, in line with [Failing closed](concepts.md#failing-closed):

1. **Never over-report.** An approval whose account or vendor is unknown is graded `single-agent`. A teammate approval is counted only when the login is listed and the review is at the current head.
2. **A missing capability turns off the feature that needs it, and takes automation's authority with it.** The required review strength can drop to what exists, but only when a person makes the merge decision. `auto` is never reached through a degrade.

| Missing capability | Effect | `orch doctor` row |
|---|---|---|
| `compute = same-vendor` or `multi-vendor`, but `[profile.accounts]` lists one account | Effective cell drops to the `one` column (A or D). Authority becomes `owner` (solo) or `teammate` (team). | `SKIP  profile accounts  same-vendor declared, but only one account is listed in [profile.accounts]; reviews count as single-agent and nothing merges automatically until a second account is added` |
| `compute = multi-vendor`, but every listed account has the same vendor | Effective cell drops to the `same-vendor` column (B or E). High-tier `needAgent` becomes cross-account, authority stays `owner`/`teammate`, and the gate line ends `degraded=no-second-vendor`. | `SKIP  profile vendors  multi-vendor declared, but every account is on 'claude'; high-risk PRs get a same-vendor review only and the owner decides` |
| An account's vendor has no agent CLI found or configured | No change to the rule (vendors are declared), but the row warns. | `SKIP  profile vendor codex  account x1 is on 'codex', but no codex CLI was found and no [agents.codex] is configured` |
| `people = team`, but `teammates` is empty | Any rule with `needTeammate` cannot pass. The gate gives BLOCKED with `no teammates listed in [profile] teammates`. No fallback to owner, because the team said a teammate decides. | `SKIP  profile teammates  people = team, but [profile] teammates is empty; high-risk PRs (and every PR in cell D) stay BLOCKED until a login is added` |
| `people = team` and live mode is not available (`gh` absent or `[merge] repo` unset) | Teammate approvals cannot be read; rules with `needTeammate` give BLOCKED. | `SKIP  profile teammate reviews  teammate approvals are read from GitHub; gh is absent or [merge] repo is unset` |
| Every agent in `[profile.agents]` is on the same account (cells B, C, E, F) | No cross-account review is possible. Low-tier authority drops from `auto` to `owner`/`teammate`. | `SKIP  profile reviewers  every agent in [profile.agents] is on account acct1; no review can be cross-account, so low-risk PRs will not merge automatically` |
| `high_paths` set, changed files unreadable | Tier = `high`. | none (the gate line says `tier=high(files unreadable)`) |
| An approval by an agent or login not in `[profile.agents]` | Graded `single-agent (unmapped)`. | `SKIP  profile agents  N agent(s) in [agents.*] have no account in [profile.agents]` |
| `[profile]` fails validation | Exit 2 from every command that reads the config (as today). | `FAIL  profile  <the validation message>` |

Profile rows are optional (`SKIP` when a capability is missing), so a partly set up profile does not fail the doctor. A malformed profile is a required `FAIL`, like any other unreadable config. When a profile is fully backed, the rows are `PASS` and name the cell, for example `PASS  profile  cell C (multi-vendor · solo): accounts acct1, acct2 (claude), x1 (codex)`.

## 8. Migration: no `[profile]` means today's behaviour, byte for byte

A config without a `[profile]` table means the profile code never runs:

- `merge-gate` prints the same bytes and exits with the same code as the release before this change, for every bundled fixture, text and `--json`, with and without `--head`. That holds in both review sources that exist when the code change lands (see PR #4 (comment review gate) and its snapshot tests).
- `merge-gate` fetches the same `gh pr view --json` field list as before.
- `doctor` prints the same rows. No "profile not set" row is added.
- `worker start` applies no worker cap.
- `init` when stdin is not a TTY, or with `--no-profile`, writes the same `config.toml` as before.
- `init` when the config already exists and `--force` is not given: unchanged (it never rewrites the file).
- `--tier` and `--auto` are rejected with exit 2, so they cannot be passed by mistake to a gate that has no policy.

Existing users opt in with `orch profile update --compute … --people …`, or by adding the table by hand.

## 9. Test plan for the code change

| Area | Tests |
|---|---|
| Policy table | One table-driven test with the 12 rows of section 5, as a literal copied from this document. Also the worker cap for each cell with `max_workers = 0` and with an override. |
| Strength grading | Same account; different account on the same vendor; different vendor; reviewer unmapped; author unmapped; several authors after a hand-off, where one shares the reviewer's account (the weakest holds); several approvals (the strongest holds). |
| Teammate approval | Listed login at the head (counts); a stale one (does not count); a login that is not listed; the teammate is also the PR author (does not count); a solo profile (`n/a`). |
| Tier | `--tier` wins; a path match raises to high; `--tier low` beats a path match; no match gives `default_tier`; files unreadable gives high; glob cases (`*` does not cross `/`, `**` does). |
| `--auto` | Passes only under `auto` authority; BLOCKED under `owner` and `teammate` even when every review rule is met. |
| Degrade | One test per row of section 7: the effective cell, the authority (never `auto` after a degrade), the gate reason text, and the doctor row text. |
| Migration | Replay the merge-gate snapshot suite with no `[profile]` and require byte-identical output. Snapshot `doctor` output with no profile. Snapshot `init` output and the written `config.toml` with stdin not a TTY. The `gh` field list without a profile and with a profile but empty `high_paths`. `--tier`/`--auto` without a profile give exit 2. |
| CLI | `init --compute/--people`; one flag alone gives exit 2; TTY questions through a fake TTY; `init --force` keeps `[profile]`; `profile show` text and `--json`; `profile update` leaves every non-profile line byte-identical; `--dry-run` writes nothing; invalid updates give exit 2 and write nothing. |
| Workers | `worker start` refuses at the cap and `--force` overrides it; no cap without a profile. |
| Fixtures | New bundled fixtures for a teammate approval at the head, a stale teammate approval, and a PR with a changed file under a sample high path. |
| Mutation check | Recorded in the PR: remove the account comparison (cross-account tests must fail); change `default_tier`'s default to `low` (tier tests must fail); remove the `--auto` authority check (`--auto` tests must fail); let a degrade keep `auto` (degrade tests must fail). |

## 10. Open questions

1. **Low tier in cells C and F.** The table asks C for a cross-account review at low tier but F for a cross-vendor one. Should both use the same low-tier minimum?
2. **Default tier.** `high` is the fail-closed choice, but it means cells B, C, E and F merge nothing automatically until you tag PRs `low`. Is that the right default, or should `init` ask for it?
3. **`--auto` flag or a new exit code.** This design keeps exit 0 for PASS and adds `--auto` for callers that merge automatically. The other option is a separate exit code for "PASS, but a person decides", which protects scripts that never pass `--auto` but changes the exit code contract.
4. **Where the profile lives.** `config.toml` is per `ORCH_HOME`, which usually means per user, while `high_paths` belong to a repository. Should a repository be able to add its own path rules (for example a file in the repository), and which one wins?
5. **Worker cap defaults.** Is `workers_per_account = 2` a sensible default, and should the cap also count the lead's own session in cells A and D?
6. **Composition with PR #4 (comment review gate).** Teammate approvals come from GitHub reviews and agent approvals from review comments. The profile gate needs both in one fetch, but that PR's current comments mode ignores GitHub approvals. That needs deciding once PR #4 settles.
7. **Does a teammate approval also count toward `required_approvals`?** This design keeps them apart: a teammate approval meets `needTeammate` but not the agent-review requirement.
8. **Declared identities.** Accounts and vendors are declared, not checked. Is it worth adding an optional check (for example, each agent CLI writing its account label into its review note), knowing it would still not be a security boundary?
