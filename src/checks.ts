// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** CI policy shared by merge-gate and review watch. */
export interface CheckRow {
  sha: string;
  name: string;
  state: string;
  /** null = unknown (including an unlisted Actions suite); "" = a status context. */
  workflow?: string | null;
}

const PASSED = new Set(["SUCCESS"]);
const NOT_APPLICABLE = new Set(["SKIPPED", "NEUTRAL"]);

export function requiredCheckNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((n) => typeof n !== "string" || !n.trim())) {
    throw new RangeError("required checks must be a list of non-empty check names");
  }
  return [...new Set(value)];
}

/**
 * Only the exact head counts. Required names match a bare name or an exact workflow/name;
 * every matching row must pass, so a duplicate SUCCESS cannot hide SKIPPED or another result.
 * An unknown same-name row never supplies a qualified requirement. If it did not pass it
 * also blocks an otherwise passing qualified requirement: it may belong to that workflow.
 * Without requirements, SUCCESS plus not-applicable checks keeps the historical verdict;
 * an empty rollup or one consisting only of not-applicable checks never establishes a pass.
 */
export function ciVerdict(head: string, rows: CheckRow[], requiredChecks: unknown = []) {
  const required = requiredCheckNames(requiredChecks);
  const at = rows.filter((r) => r.sha.toLowerCase() === head.toLowerCase());
  const up = (c: CheckRow) => c.state.toUpperCase();
  const bad = at.filter((c) => !PASSED.has(up(c)) && !NOT_APPLICABLE.has(up(c)));
  const passed = at.some((c) => PASSED.has(up(c)));
  const unmet: [string, string][] = [];
  for (const want of required) {
    const hits = at.filter((c) => want === c.name ||
      (typeof c.workflow === "string" && c.workflow !== "" && want === `${c.workflow}/${c.name}`));
    const notPassed = hits.find((c) => !PASSED.has(up(c)));
    const unsure = at.filter((c) => c.workflow == null && c.name !== "" && want !== c.name && want.endsWith("/" + c.name));
    if (notPassed) unmet.push([want, up(notPassed) || "PENDING"]);
    else if (unsure.some((c) => !PASSED.has(up(c))) || (!hits.length && unsure.length)) {
      unmet.push([want, "WORKFLOW_UNKNOWN"]);
    } else if (!hits.length) unmet.push([want, "ABSENT"]);
  }
  return { ok: bad.length === 0 && passed && unmet.length === 0, at, bad, passed, unmet };
}
