// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// OS-F1 round-3 scenario tables, plus OS-2 required-check acceptance cases.
export const HEAD = "1111111111111111111111111111111111111111";
export const OLD_HEAD = "2222222222222222222222222222222222222222";
export interface Run {
  name: string;
  workflow: string;
  state: string;
  suite: number;
  sha: string;
}
const check = (state: string, suite = 11, workflow = "CI", name = "test", sha = HEAD): Run =>
  ({ name, workflow, state, suite, sha });
export interface Scenario {
  title: string;
  runs: Run[];
  workflows: [number, string][] | null;
  gateGreen: boolean;
  watchGreen: boolean;
  gateReason?: string;
  watchReason?: string;
  required?: string[];
}
const known = [[11, "CI"], [12, "CI"]] as [number, string][];
export const scenarios: Scenario[] = [
  // All five rows of round 3 section 1 (REVIEW.md:281), including its green control.
  { title: "round3 original: CI success plus unlisted skipped suite", runs: [check("SUCCESS"), check("SKIPPED", 12)], workflows: [[11, "CI"]], gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "round3 same with neutral", runs: [check("SUCCESS"), check("NEUTRAL", 12)], workflows: [[11, "CI"]], gateGreen: false, watchGreen: false, gateReason: "NEUTRAL", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "round3 every suite unlisted: success plus skipped", runs: [check("SUCCESS"), check("SKIPPED", 12)], workflows: [], gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "round3 workflow list unreadable", runs: [check("SUCCESS"), check("SKIPPED", 12)], workflows: null, gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "round3 exact workflow passed plus unknown same-name passed", runs: [check("SUCCESS"), check("SUCCESS", 12)], workflows: [[11, "CI"]], gateGreen: true, watchGreen: true },
  // All five missing-workflow rows of round 3 section 2 (REVIEW.md:305).
  { title: "Other test passed and listed cannot supply CI/test", runs: [check("SUCCESS", 11, "Other")], workflows: [[11, "Other"]], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "Other test passed but unlisted cannot supply CI/test", runs: [check("SUCCESS", 11, "Other")], workflows: [], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "Other listed plus unlisted successes cannot supply CI/test", runs: [check("SUCCESS", 11, "Other"), check("SUCCESS", 12, "Other")], workflows: [[11, "Other"]], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "another app test success cannot supply CI/test", runs: [check("SUCCESS", 11, "")], workflows: [], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "CI lint listed plus Other test unlisted cannot supply CI/test", runs: [check("SUCCESS", 11, "CI", "lint"), check("SUCCESS", 12, "Other")], workflows: [[11, "CI"]], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "required workflow job missing alongside unrelated success", runs: [check("SUCCESS", 11, "CI", "lint")], workflows: [[11, "CI"]], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "only stale required success alongside head lint", runs: [check("SUCCESS", 11, "CI", "test", OLD_HEAD), check("SUCCESS", 12, "CI", "lint")], workflows: known, gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "short sha cannot supply exact-head required success", runs: [check("SUCCESS", 11, "CI", "test", HEAD.slice(0, 9)), check("SUCCESS", 12, "CI", "lint")], workflows: known, gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "stale skipped duplicate cannot poison head success", runs: [check("SUCCESS"), check("SKIPPED", 12, "CI", "test", OLD_HEAD)], workflows: known, gateGreen: true, watchGreen: true },
  { title: "required check absent in an empty rollup", runs: [], workflows: [], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "all required duplicates passed", runs: [check("SUCCESS"), check("success", 12)], workflows: known, gateGreen: true, watchGreen: true },
  ...["SKIPPED", "NEUTRAL", "CANCELLED", "FAILURE", "PENDING", "QUEUED", "IN_PROGRESS", "", " SUCCESS "].map((state): Scenario => ({
    title: `required check ${JSON.stringify(state)} alongside unrelated success`, runs: [check(state), check("SUCCESS", 12, "CI", "lint")], workflows: known,
    gateGreen: false, watchGreen: false, gateReason: state || "PENDING", watchReason: state || "PENDING",
  })),
  ...["SKIPPED", "NEUTRAL", "CANCELLED", "FAILURE", "IN_PROGRESS"].flatMap((state) => [false, true].map((reverse): Scenario => ({
    title: `ambiguous required duplicate SUCCESS plus ${state}, reverse=${reverse}`,
    runs: reverse ? [check(state, 12), check("SUCCESS")] : [check("SUCCESS"), check(state, 12)], workflows: known,
    gateGreen: false, watchGreen: false, gateReason: state, watchReason: state,
  }))),
  ...["SKIPPED", "NEUTRAL"].map((state): Scenario => ({
    title: `round3 another app's same-name ${state} conservatively blocks watch`, runs: [check("SUCCESS"), check(state, 12, "")], workflows: [[11, "CI"]],
    gateGreen: true, watchGreen: false, watchReason: "WORKFLOW_UNKNOWN",
  })),
  { title: "plain requirement still blocks skipped duplicates with missing workflow list", runs: [check("SUCCESS"), check("SKIPPED", 12)], workflows: [], required: ["test"], gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "SKIPPED" },
  { title: "case sensitive qualified name", runs: [check("SUCCESS")], workflows: known, required: ["ci/test"], gateGreen: false, watchGreen: false, gateReason: "ABSENT", watchReason: "ABSENT" },
  { title: "nested workflow name with unknown job", runs: [check("SKIPPED", 11, "a/b")], workflows: [], required: ["a/b/test"], gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "WORKFLOW_UNKNOWN" },
  { title: "blank workflow name is unknown with a skipped duplicate", runs: [check("SUCCESS"), check("SKIPPED", 12)], workflows: [[11, "CI"], [12, ""]], gateGreen: false, watchGreen: false, gateReason: "SKIPPED", watchReason: "WORKFLOW_UNKNOWN" },
];

export function prData(s: Scenario) {
  return {
    headRefOid: HEAD, state: "OPEN", author: { login: "author" }, labels: [],
    reviews: [{ author: { login: "reviewer" }, state: "APPROVED", commit: { oid: HEAD } }],
    comments: [{ body: `ORCH-REVIEW APPROVE ${HEAD} by reviewer` }],
    statusCheckRollup: s.runs.map((r) => ({ name: r.name, workflowName: r.workflow, conclusion: r.state || null, headSha: r.sha })),
  };
}
