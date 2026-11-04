// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from "vitest";
import { run, useTmpHome } from "./_helpers.js";

describe("doctor skill pack", () => {
  useTmpHome();

  it("test_doctor_passes_without_skills", async () => {
    expect((await run("init", "--no-profile", "--no-handbook"))[0]).toBe(0);
    const [code, out] = await run("doctor");
    expect(code).toBe(0);
    expect(out).toMatch(/PASS {2}skills\s+0 installed\/16 shipped, 0 modified \(not installed\)/);
    expect(out).toContain("doctor: PASS (0 required check(s) failed)");
  });
});
