# Profiles: declared review context and one selected policy

A profile is an optional `[profile]` table in `config.toml`. It holds two things:

- **Declared review context**: labels you write for the agent accounts you use, the agent CLI ("vendor") each account is on, which agent runs on which account, and which GitHub logins are teammates.
- **One selected policy**: the rule the merge gate applies on top of its plain rule. This release has one public policy, `human-merge`. You select it by name and you give its two values yourself. `orch` has no default for the policy, the review requirement or the worker limit: until you give all three, no `[profile]` table is written.

Without a `[profile]` table none of this runs, and the merge gate behaves as described in [commands.md](commands.md#orch-merge-gate) (section 7 below).

**Limits, stated once.** ORCH-os never reads credentials and cannot see which login an agent CLI is using. Accounts, vendors and agent names are **declared, not verified**. A strength label such as `cross-vendor` says that the declared labels of the reviewer and the author differ. It does not show that two reviews are independent, and it is not a measure of review quality. The profile gate is a process gate between cooperating agents, not a security boundary.

## 1. The public example policy: `human-merge`

| Rule | Where the value comes from |
|---|---|
| Every PR needs an agent review by a non-author, at the PR's current head, graded at or above `required_review`. | `[profile] required_review`, written by you. The same value applies to both tiers. |
| In a `team` profile, a `high`-tier PR also needs an `APPROVED` GitHub review at the current head from a login in `teammates`. | `[profile] people`, `teammates`, and the tier (section 4). |
| A person performs every merge. `orch merge-gate --auto` is always `BLOCKED`. | Fixed. No setting gives automation merge authority. |
| `orch worker start` and a `review watch` dispatch are refused while `max_workers` workers are already running. `orch worker start --force` overrides the limit and prints a warning. The count and the start are two steps, so two starts at the same instant can both pass. | `[profile] max_workers`, written by you. |

Nothing is derived from how many accounts or vendors you list. If the setup cannot give the review strength you asked for, the gate reports `BLOCKED` and `orch doctor` names what is missing (section 5). The rule is not lowered.

A `PASS` means the rule is met. It does not merge anything: no `orch` command merges a PR.

### Example

One person, one agent account, synthetic names. The person reads the gate verdict and merges by hand:

```toml
[profile]
policy = "human-merge"
compute = "one"
people = "solo"
required_review = "single-agent"
max_workers = 1

[profile.accounts]
main = "claude"

[profile.agents]
lead = "main"
w1 = "main"
r1 = "main"
```

`orch init` and `orch profile update` write a new profile only when you give all three values yourself: as flags (`--policy human-merge --required-review … --max-workers N`, together with `--compute` and `--people`), or as answers to the questions `orch init` asks on a terminal. Those three questions have no default answer. When a value is missing, no `[profile]` table is written and the command prints how to create one. The values above are an example, not a default. Change them later with `orch profile update --required-review … --max-workers …`.

```text
#103 head=0a1b2c3d4 ci=green approvals=1/1 (stale=0 self=0) changes_requested=0 label=off
profile=human-merge tier=high(default) review=single-agent needed=single-agent teammate=n/a authority=owner
=> PASS (single-agent review only; the owner decides the merge)
```

## 2. The `[profile]` tables

The profile is one `[profile]` table and two sub-tables, in `$ORCH_HOME/config.toml` (default `~/.orch/config.toml`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `[profile] policy` | string | required | `human-merge`. A profile without this key is refused (section 6). |
| `[profile] required_review` | string | required | Weakest agent review that passes: `single-agent`, `cross-account` or `cross-vendor` (section 3) |
| `[profile] max_workers` | integer | required | The limit on running workers, an integer ≥ 1 that you choose. It is checked when `orch worker start` or `review watch` starts a worker; `worker start --force` overrides it with a warning (section 1). |
| `[profile] compute` | string | required | Declared context: `one` account, several accounts on the `same-vendor` agent CLI, or `multi-vendor`. Used for the `orch doctor` rows and the starting accounts `orch init` writes. It selects no rule. |
| `[profile] people` | string | required | `solo`, or `team` (teammates approve on GitHub) |
| `[profile] lead_account` | string | the only account, if there is one | Account id the lead runs on |
| `[profile] default_tier` | string | `high` | Tier when neither `--tier` nor a path rule decides |
| `[profile] high_paths` | array of strings | `[]` | Glob patterns (`*`, `**`). A PR that changes any matching file is `high`. |
| `[profile] teammates` | array of strings | `[]` | GitHub logins whose approving review counts as a teammate review |
| `[profile.accounts] ID = VENDOR` | string → string | none | Each account id you choose, and its vendor: an agent CLI name as `orch agents` prints it, or a custom `[agents.NAME]` |
| `[profile.agents] NAME = ID` | string → string | none | The account each reviewing or authoring agent runs on. NAME is the name on reviews: the agent name in a review comment, or the GitHub login when the review source is `github`. |

Validation (a violation is a config error: exit 2 with a one-line message):

- `policy`, `required_review`, `compute`, `people` and `default_tier` hold one of the listed values.
- `max_workers` is an integer ≥ 1.
- Every value in `[profile.agents]` is a key of `[profile.accounts]`; `lead_account`, when set, is too.
- An unknown key is an error.

A declared `compute` that the accounts table does not back (for example `same-vendor` with one account listed) is not a config error. It is a missing capability (section 5).

## 3. Review strength labels

The gate already decides which approvals count: at the current head, not by the author, latest per reviewer, not blocked by a later "changes requested". The profile does not change which approvals count. It labels the ones that do, from the declared tables:

| Condition | Label |
|---|---|
| The reviewer or an author is not in `[profile.agents]` | `single-agent (unmapped)`. Unknown counts as weakest. |
| Same declared account as the author | `single-agent` |
| Different declared account, same declared vendor | `cross-account` |
| Different declared vendor | `cross-vendor` |

The author is the PR's author in `github` mode, or every agent that has held the task in `comments` mode. With several authors, the reviewer is compared with each one and the weakest label holds. Across several counting approvals, the strongest label is the one achieved (`none` without one).

A **teammate approval** is a GitHub review with state `APPROVED` at the current head, by a login listed in `teammates`, and not by the PR's author. Its value is `approved`, `missing`, or `n/a` in a solo profile. A teammate's approval is not an agent review.

A PR passes when every plain rule passes, the achieved label is at or above `required_review`, a required teammate approval is `approved`, and `--auto` was not given.

`--json` adds one object, `profile`, to the result: `{policy, tier, tier_source, achieved, needed, teammate, need_teammate, authority, worker_cap, reasons}`.

## 4. Tier

Every PR is `low` or `high`. In order; the first rule that decides wins:

1. `merge-gate --tier low|high`.
2. `high_paths`: if any changed file matches any pattern, the tier is `high`. Path rules can only raise the tier.
3. `default_tier` (default `high`).

If the profile has `high_paths` and the changed-file list cannot be read in full, the tier is `high`. Two cases are not raised: `--tier low` is taken as given even when the list cannot be read, and a profile without `high_paths` does not read the list, so its tier is `default_tier`. `--tier` and `default_tier` accept only `low` and `high`; any other value is an error (exit 2). The verdict prints where the tier came from: `flag`, `path: FILE`, `default` or `files unreadable`.

Under `human-merge` the tier decides one thing: whether a `team` profile needs a teammate approval. It never lowers `required_review`. In a `solo` profile the tier is printed and changes no requirement.

## 5. Missing capabilities

A missing capability never lowers the rule. The gate keeps the values written in the profile and reports `BLOCKED`; `orch doctor` and `orch profile show` name what is missing, as optional (`SKIP`) rows:

| Missing | Effect | `orch doctor` row |
|---|---|---|
| `compute` declares several accounts, but `[profile.accounts]` lists one | No review can be labelled above `single-agent`. | `SKIP  profile accounts  …` |
| `compute = multi-vendor`, but every listed account has the same vendor | No review can be labelled `cross-vendor`. | `SKIP  profile vendors  …` |
| `required_review` is `cross-account` or `cross-vendor`, but the agents in `[profile.agents]` are on one account or one vendor | Every PR stays `BLOCKED` until an agent on another account or vendor is added. | `SKIP  profile reviewers  …` |
| An account's vendor has no agent CLI found or configured | No change to the rule; the row warns. | `SKIP  profile vendor NAME  …` |
| `people = team`, but `teammates` is empty | High-tier PRs stay `BLOCKED` with `no teammates listed in [profile] teammates`. | `SKIP  profile teammates  …` |
| `people = team` and `gh` is absent or `[merge] repo` is unset | Teammate approvals cannot be read; high-tier PRs stay `BLOCKED`. | `SKIP  profile teammate reviews  …` |
| `high_paths` set, changed files unreadable | Tier = `high`. | none (the gate line says `tier=high(files unreadable)`) |
| An approval by an agent or login not in `[profile.agents]` | Labelled `single-agent (unmapped)`. | `SKIP  profile agents  …` |
| `[profile]` fails validation | Exit 2 from every command that reads the profile. | `FAIL  profile  <the message>` |

## 6. Migrating a profile written for the removed built-in table

An earlier source version of orch-os (the `main` branch after the `v2.0.1` tag; the `v2.0.1` tag itself has no profiles) chose the review rule, the merge authority and the worker limit from a built-in table keyed on `compute` and `people`. That table is removed. A `[profile]` written for it has no `policy` key, and every command that reads the profile (`merge-gate`, `review watch`, `worker start`, `profile show`) now exits 2 with:

```text
[profile] has no policy key: it may have been written for the built-in compute x people table that an earlier orch-os source version carried, or written by hand. That table is removed. No rule is chosen for you and none is applied; set policy = "human-merge", required_review = "single-agent" | "cross-account" | "cross-vendor" and max_workers = N (N >= 1) in [profile], using `orch profile update --policy human-merge --required-review single-agent|cross-account|cross-vendor --max-workers N`; a person performs every merge under this policy (docs/profiles.md)
```

The old profile is not converted for you, because the public policy could require less than the rule you had. Choose the values yourself:

| Old behaviour | Now |
|---|---|
| A `team` profile with one account needed a teammate approval on the low tier as well. | A teammate approval is needed on the high tier only. |
| The review strength needed came from the table and could differ by tier. | `required_review`, one value you write. It is the same on both tiers. |
| Some setups let `merge-gate --auto` pass. | `--auto` is always `BLOCKED`. A person merges. |
| `max_workers = 0` (or no key) derived a limit from the number of accounts and `workers_per_account`. | `max_workers` is required and ≥ 1. `workers_per_account` is refused; `orch profile update --max-workers N` removes it. |
| Fewer accounts or vendors than declared switched to a weaker rule. | The rule stays as written and the gate reports `BLOCKED` (section 5). |

`orch doctor` shows the refusal as a `FAIL  profile` row. Commands that do not read the profile are unaffected.

### `--json` output: a wire compatibility change

A script that reads `--json` output written for the removed built-in table must be updated. These are all the key changes:

| Command | Removed keys | Changed or added keys |
|---|---|---|
| `orch merge-gate --json`, the `profile` object | `cell`, `declared_cell`, `degraded` | `policy` is added and holds the policy name (`"human-merge"`). `authority` is `owner` or `teammate`, never `auto`. `needed` is the written `required_review` on both tiers. `worker_cap` is the written `max_workers`. |
| `orch profile show --json` | `cell`, `declared_cell`, `effective_compute`, `workers_per_account`, `degraded` | `policy` was an object with a `low` and a `high` rule and is now the policy name, a string. The two per-tier rules moved to the new key `rules`, with the same inner keys (`need_agent`, `need_teammate`, `authority`, `worker_cap`). `required_review` is added. `max_workers` is always an integer ≥ 1. |
| `orch review watch --json`, the `choice` object | `cell` | `policy` replaces `cell`: the policy name, or `null` when there is no `[profile]`. |

`profile show --json` before and after, for the changed keys only:

```text
before: {"cell": "C", "policy": {"low": {...}, "high": {...}}, "degraded": [], ...}
after:  {"policy": "human-merge", "required_review": "cross-account", "rules": {"low": {...}, "high": {...}}, "max_workers": 2, ...}
```

## 7. No `[profile]` means the plain gate, byte for byte

A config without a `[profile]` table means the profile code never runs:

- `merge-gate` prints the same bytes and exits with the same code as the release before profiles, for every bundled fixture, text and `--json`, with and without `--head`, in both review sources.
- `merge-gate` fetches the same `gh pr view --json` field list as before.
- `doctor` prints the same rows. No "profile not set" row is added.
- `worker start` applies no worker limit.
- `init` when stdin is not a TTY, or with `--no-profile`, writes the same `config.toml` as before.
- `--tier` and `--auto` are rejected with exit 2, so they cannot be passed by mistake to a gate that has no policy.
