// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// docs/tests-map.md is checked here: every v1.1 test row must name a vitest test that exists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";

describe("TestsMapV2", () => {
  it("every_v1_test_in_the_map_has_a_vitest_counterpart", () => {
    const map = readFileSync(join(ROOT, "docs", "tests-map.md"), "utf8").replace(/\r\n?/g, "\n");
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
});
