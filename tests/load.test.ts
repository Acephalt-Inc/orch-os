// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as C from "../src/config.js";
import * as L from "../src/load.js";
import { parseToml } from "../src/toml.js";
import { useTmpHome } from "./_helpers.js";

describe("LoadTest", () => {
  const ctx = useTmpHome();
  const cfg = () => parseToml(C.renderDefault(ctx.home));

  it("test_levels", () => {
    const th = L.thresholds(cfg());
    expect(L.level({ load_ratio: 0.2 }, th)).toBe("NORMAL");
    expect(L.level({ load_ratio: 0.8 }, th)).toBe("BUSY");
    expect(L.level({ load_ratio: 1.1 }, th)).toBe("HIGH");
    expect(L.level({ swap_pct: 95 }, th)).toBe("HIGH");
    expect(L.level({ load_ratio: 2.0 }, th)).toBe("CRITICAL");
    expect(L.level({ load_ratio: null, swap_pct: null }, th)).toBe("NORMAL");
  });

  it("test_needs_two_samples_up_three_down", () => {
    const c = cfg();
    const p = `${ctx.home}/load.json`;
    expect(L.step(c, p, { load_ratio: 1.2 }).tier).toBe("NORMAL");
    expect(L.step(c, p, { load_ratio: 1.2 }).tier).toBe("HIGH");
    // 0.95 is below HIGH (1.0) but inside the 0.1 margin: stays HIGH
    let st: Record<string, any> = {};
    for (let i = 0; i < 3; i++) st = L.step(c, p, { load_ratio: 0.95 });
    expect(st.tier).toBe("HIGH");
    for (let i = 0; i < 3; i++) st = L.step(c, p, { load_ratio: 0.1 });
    expect(st.tier).toBe("NORMAL");
  });

  it.skipIf(process.platform === "win32")("test_temp_command_is_optional_and_parsed", () => {
    expect(L.tempC("")).toBeNull();
    expect(L.tempC("echo 71.5")).toBe(71.5);
    expect(L.tempC("echo no-number")).toBeNull();
  });

  it("test_real_sample_is_portable", () => {
    const s = L.takeSample(cfg());
    expect(typeof s.load_ratio).toBe("number");
    expect(s.temp_c).toBeNull(); // no temp_command by default
  });
});

describe("LoadV2", () => {
  const ctx = useTmpHome();

  it("state_file_keeps_the_v1_layout_and_history_cap", () => {
    const c = parseToml(C.renderDefault(ctx.home));
    const p = `${ctx.home}/load.json`;
    for (let i = 0; i < 7; i++) L.step(c, p, { ts: i, load_ratio: 0.1 });
    const text = readFileSync(p, "utf8");
    expect(text.startsWith('{\n "ts": 6,\n "load_ratio": 0.1,')).toBe(true);
    expect(JSON.parse(text).history).toHaveLength(5);
    expect(L.readState(`${ctx.home}/missing.json`)).toEqual({});
  });

  it("unknown_stored_tier_resets_to_normal", () => {
    const c = parseToml(C.renderDefault(ctx.home));
    const p = `${ctx.home}/load.json`;
    L.step(c, p, { load_ratio: 0.1 });
    const st = JSON.parse(readFileSync(p, "utf8"));
    st.tier = "MELTDOWN";
    writeFileSync(p, JSON.stringify(st));
    expect(L.step(c, p, { load_ratio: 0.1 }).previous_tier).toBe("NORMAL");
  });
});
