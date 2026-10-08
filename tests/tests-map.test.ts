// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// docs/tests-map.md is checked here: every v1.1 test row and every ownership witness must name a vitest test that exists.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";

describe("TestsMapV2", () => {
  it("every_v1_test_in_the_map_has_a_vitest_counterpart", () => {
    const map = readFileSync(join(ROOT, "docs", "tests-map.md"), "utf8");
    const row = /^\| (\d+) \| `tests\/(test_\w+)\.py` `(\w+)\.(test_\w+)` \| `(tests\/[\w.-]+\.test\.ts)` `(\w+) > (test_\w+)` \|$/gm;
    const rows = [...map.matchAll(row)];
    expect(rows.length).toBe(59);
    expect(rows.map((r) => Number(r[1]))).toEqual(Array.from({ length: 59 }, (_, i) => i + 1));
    for (const [, , pyFile, pyClass, pyName, tsFile, tsDescribe, tsTest] of rows) {
      expect([tsDescribe, tsTest]).toEqual([pyClass, pyName]);
      expect(tsFile).toBe(`tests/${pyFile.replace(/^test_/, "")}.test.ts`);
      const src = readFileSync(join(ROOT, tsFile), "utf8");
      expect(src, `${tsFile}: describe ${tsDescribe}`).toMatch(new RegExp(`describe(?:\\.skipIf\\([^)]*\\))?\\("${tsDescribe}"`));
      expect(src, `${tsFile}: it ${tsTest}`).toContain(`it("${tsTest}"`);
    }
  });

  it("every_ownership_witness_in_the_map_names_an_existing_test", () => {
    const map = readFileSync(join(ROOT, "docs", "tests-map.md"), "utf8");
    const rows = map.slice(map.indexOf("## OS-3 ownership witnesses")).split("\n").filter((line) => /^\| [^|]+ \| `/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(9);
    // describe name -> the source text of that describe block
    const blocks = new Map<string, string>();
    for (const file of readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.ts"))) {
      const parts = readFileSync(join(ROOT, "tests", file), "utf8").split(/^describe\("(\w+)"/m);
      for (let i = 1; i < parts.length; i += 2) blocks.set(parts[i], parts[i + 1]);
    }
    for (const row of rows) {
      let group = ""; // a name without "Group > " belongs to the group named before it in the row
      const names = [...row.split("|")[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      expect(names.length, row).toBeGreaterThan(0);
      for (const name of names) {
        const at = name.split(" > ");
        if (at.length === 2) group = at[0];
        const test = at[at.length - 1];
        expect(blocks.has(group), `${name}: describe ${group}`).toBe(true);
        // a plain test, or a parameterised one whose title continues after ": "
        expect(new RegExp(`\\("${test}(: [^"]*)?", `).test(blocks.get(group)!), `${group} > ${test}`).toBe(true);
      }
    }
  });
});
