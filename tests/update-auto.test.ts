import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_UPDATE_COMMANDS, CHECK_INTERVAL_MS, autoUpdateEnabled, isAllowlisted, isAutoUpdateDue, setAutoUpdate, statusText } from "../src/update-auto.js";

const home = () => mkdtempSync(join(tmpdir(), "orch-update-auto-"));

describe("weekly auto-update switch and cadence", () => {
  it("writes the exact off marker and removes it on enable", () => {
    const h = home();
    setAutoUpdate(h, false);
    expect(readFileSync(join(h, "update-auto"), "utf8")).toBe("off\n");
    setAutoUpdate(h, true);
    expect(existsSync(join(h, "update-auto"))).toBe(false);
  });
  it("is default-on and honors only ORCH_AUTO_UPDATE=0", () => {
    const h = home();
    expect(autoUpdateEnabled(h, {})).toBe(true);
    expect(autoUpdateEnabled(h, { ORCH_AUTO_UPDATE: "0" })).toBe(false);
  });
  it("treats missing, malformed, future, and exactly-seven-day timestamps as due", () => {
    const now = Date.parse("2026-01-08T00:00:00Z");
    expect(isAutoUpdateDue(null, now)).toBe(true);
    expect(isAutoUpdateDue(7 as never, now)).toBe(true);
    expect(isAutoUpdateDue("2026-01-01T00:00:00Z", now)).toBe(true);
    expect(isAutoUpdateDue("2026-01-10T00:00:00Z", now)).toBe(true);
    expect(isAutoUpdateDue(new Date(now - CHECK_INTERVAL_MS + 1).toISOString(), now)).toBe(false);
  });
  it("pins the complete allowlist and excludes help and prefix matches", () => {
    expect(AUTO_UPDATE_COMMANDS).toEqual(["agents", "lease status", "doctor"]);
    expect([isAllowlisted(["agents"]), isAllowlisted(["lease", "status"]), isAllowlisted(["doctor"])]).toEqual([true, true, true]);
    expect([isAllowlisted(["agents", "--help"]), isAllowlisted(["lease"]), isAllowlisted(["update", "check"])]).toEqual([false, false, false]);
  });
  it("renders missing state locally and redacts POSIX and Windows paths", () => {
    const h = home();
    expect(statusText(h, {}, 0)).toContain("last check: never\nnext due: due");
    writeFileSync(join(h, "update-state.json"), JSON.stringify({ schema: 1, last_check_at: "2026-01-01T00:00:00.000Z", backup: "/home/alice/.orch/config.toml.backup-1", log: "C:\\Users\\Alice\\.orch\\secret.log" }));
    const text = statusText(h, {}, Date.parse("2026-01-02T00:00:00Z"));
    expect(text).toContain("settings backup kept: config.toml.backup-1");
    expect(text).toContain("diagnostic: secret.log");
    expect(text).not.toContain("/home/alice");
    expect(text).not.toContain("C:\\Users");
  });
});
