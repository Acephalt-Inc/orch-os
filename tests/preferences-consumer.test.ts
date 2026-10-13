// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The filter is a pure function of labels its caller supplies. These tests cover the function only:
// nothing here shows what an assistant does with saved settings in a shared or a personal task.
import { describe, expect, it } from "vitest";
import { personalDisplaySettings, type PreferenceView } from "../src/preferences/schema.js";

const view: PreferenceView = { source: "explicit-command", revision: 1, preferences: { "answer-length": "short", "response-language": "zh" }, expiry: {} };

describe("personal display filter", () => {
  it("returns no settings when the caller labels the context shared", () => {
    expect(personalDisplaySettings(view, "shared", true)).toEqual({});
    expect(personalDisplaySettings(view, "shared", false)).toEqual({});
  });

  it("returns the saved settings only for a personal context the caller can keep separate", () => {
    expect(personalDisplaySettings(view, "personal", true)).toEqual({ "answer-length": "short", "response-language": "zh" });
    expect(personalDisplaySettings(view, "personal", false)).toEqual({});
  });

  it("returns a copy, so changing the result does not change the view", () => {
    const settings = personalDisplaySettings(view, "personal", true);
    settings["answer-length"] = "normal";
    expect(view.preferences["answer-length"]).toBe("short");
  });
});
