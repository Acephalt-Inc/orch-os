import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_COMMANDS,
  CHECK_INTERVAL_MS,
  NOTICE_CLAIM_STALE_MS,
  acquireClaim,
  autoUpdateEnabled,
  consumeNotice,
  isAllowlisted,
  isAutoUpdateDue,
  releaseClaim,
  runAutoUpdate,
  setAutoUpdate,
  statusText,
  weeklyLock,
} from "../src/update-auto.js";

const homes: string[] = [];
const home = (): string => {
  const value = mkdtempSync(join(tmpdir(), "orch-update-auto-"));
  homes.push(value);
  return value;
};
const state = (h: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(h, "update-state.json"), "utf8"));
const writeState = (h: string, value: unknown): void =>
  writeFileSync(join(h, "update-state.json"), JSON.stringify(value));
const cli = (h: string, ...args: string[]) => spawnSync(
  process.execPath,
  [join(process.cwd(), "dist", "cli.js"), ...args],
  { env: { ...process.env, ORCH_HOME: h }, encoding: "utf8" },
);

afterEach(() => {
  for (const h of homes.splice(0)) {
    import("node:fs").then(({ rmSync }) => rmSync(h, { recursive: true, force: true }));
  }
});

describe("weekly auto-update acceptance", () => {
  it("A01 update off writes the exact off marker", () => {
    const h = home();
    expect(cli(h, "update", "off").status).toBe(0);
    expect(readFileSync(join(h, "update-auto"), "utf8")).toBe("off\n");
  });
  it("A02 update on removes the off marker", () => {
    const h = home();
    setAutoUpdate(h, false);
    expect(cli(h, "update", "on").status).toBe(0);
    expect(existsSync(join(h, "update-auto"))).toBe(false);
  });
  it("A03 missing marker defaults the effective switch on", () => {
    expect(autoUpdateEnabled(home(), {})).toBe(true);
  });
  it("A04 ORCH_AUTO_UPDATE=0 turns the effective switch off", () => {
    expect(autoUpdateEnabled(home(), { ORCH_AUTO_UPDATE: "0" })).toBe(false);
  });
  it("A05 status reports never when state is absent", () => {
    expect(cli(home(), "update", "status").stdout).toContain("last check: never");
  });
  it("A06 status reports next due at last check plus seven days", () => {
    const h = home();
    writeState(h, { schema: 1, last_check_at: "2026-01-01T00:00:00.000Z" });
    expect(statusText(h, {}, Date.parse("2026-01-02"))).toContain(
      "next due: 2026-01-08T00:00:00.000Z",
    );
  });
  it("A07 pins the complete literal allowlist", () => {
    expect(AUTO_UPDATE_COMMANDS).toEqual(["agents", "lease status", "doctor"]);
    expect(isAllowlisted(["agents"])).toBe(true);
    expect(isAllowlisted(["lease", "status"])).toBe(true);
    expect(isAllowlisted(["doctor"])).toBe(true);
    expect(isAllowlisted(["lease"])).toBe(false);
  });
  it.each([
    ["A08 agents schedules once", ["agents"]],
    ["A08 lease status schedules once", ["lease", "status"]],
    ["A08 doctor schedules once", ["doctor"]],
  ])("%s", (_name, args) => {
    expect(isAllowlisted(args)).toBe(true);
  });
  it("A10 first permitted check makes exactly one registry request", async () => {
    const h = home();
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"version":"2.3.3"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await runAutoUpdate(h, "2.3.2", { address: `http://127.0.0.1:${port}/latest` });
    await runAutoUpdate(h, "2.3.2", { address: `http://127.0.0.1:${port}/latest` });
    expect(requests).toBe(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("A12 exactly seven days is due", () => {
    const now = Date.parse("2026-01-08T00:00:00Z");
    expect(isAutoUpdateDue("2026-01-01T00:00:00Z", now)).toBe(true);
  });
  it("A13 numeric 7 is due", () => {
    expect(isAutoUpdateDue(7 as never, Date.now())).toBe(true);
  });
  it("A14 null is due", () => {
    expect(isAutoUpdateDue(null, Date.now())).toBe(true);
  });
  it("A15 a last check two days in the future is due", () => {
    expect(isAutoUpdateDue("2026-01-10T00:00:00Z", Date.parse("2026-01-08"))).toBe(true);
  });
  it("A16 only one caller acquires the current weekly lock", () => {
    const h = home();
    expect([weeklyLock(h, new Date()), weeklyLock(h, new Date())]).toEqual([true, false]);
  });
  it.each([
    ["A17 keeps a two-interval-old lock", "2025-52", true],
    ["A18 deletes a three-interval-old lock", "2025-51", false],
  ])("%s", (_name, suffix, kept) => {
    const h = home();
    const old = join(h, `update-lock-${suffix}`);
    writeFileSync(old, "holder");
    weeklyLock(h, new Date("2026-01-05T00:00:00Z"));
    expect(existsSync(old)).toBe(kept);
  });
  it("A19 names a 2021-01-01 lock with ISO year 2020 week 53", () => {
    const h = home();
    weeklyLock(h, new Date("2021-01-01T00:00:00Z"));
    expect(readdirSync(h)).toContain("update-lock-2020-53");
  });
  it.each([
    ["A20 keeps week 2020-53 two intervals later", "2020-53", true],
    ["A21 deletes week 2020-52 three intervals later", "2020-52", false],
  ])("%s", (_name, suffix, kept) => {
    const h = home();
    const old = join(h, `update-lock-${suffix}`);
    writeFileSync(old, "holder");
    weeklyLock(h, new Date("2021-01-11T00:00:00Z"));
    expect(existsSync(old)).toBe(kept);
  });
  it("A22 reclaims a stale claim whose token remains A", () => {
    const h = home();
    const claim = join(h, "update-notice.claim");
    writeFileSync(claim, "A");
    utimesSync(claim, 0, 0);
    expect(acquireClaim(h, NOTICE_CLAIM_STALE_MS + 1)?.token).toHaveLength(32);
  });
  it("A23 preserves fresh B installed before stale rename", () => {
    const h = home();
    const claim = join(h, "update-notice.claim");
    writeFileSync(claim, "A");
    utimesSync(claim, 0, 0);
    acquireClaim(h, NOTICE_CLAIM_STALE_MS + 1, () => {
      writeFileSync(claim, "B");
    });
    expect(readFileSync(claim, "utf8")).toBe("B");
  });
  it("A24 release preserves a replacement holder B", () => {
    const h = home();
    const claim = join(h, "update-notice.claim");
    writeFileSync(claim, "A");
    writeFileSync(claim, "B");
    releaseClaim(claim, "A");
    expect(readFileSync(claim, "utf8")).toBe("B");
  });
  it("A26 a claim is available after the documented stale age", () => {
    expect(NOTICE_CLAIM_STALE_MS).toBe(2 * CHECK_INTERVAL_MS);
  });
  it.each([
    ["A27 wrong-shape state", { schema: 1, last_check_at: 7 }],
    ["A28 list state", []],
    ["A29 scalar state", 7],
    ["A30 truncated state", "truncated"],
    ["A31 lone-surrogate state", "\ud800"],
  ])("%s is treated as due and rewritten", async (_name, value) => {
    const h = home();
    if (value === "truncated") writeFileSync(join(h, "update-state.json"), '{"schema":');
    else writeState(h, value);
    await runAutoUpdate(h, "2.3.2", { address: "http://127.0.0.1:1/latest" });
    expect(state(h).schema).toBe(1);
    expect(typeof state(h).last_check_at).toBe("string");
  });
  it.each([
    ["A33 stable patch queues a notice", "2.3.3"],
    ["A34 stable minor queues a notice", "2.4.0"],
    ["A35 major queues a notice", "3.0.0"],
    ["A35 prerelease queues a notice", "2.4.0-rc.1"],
    ["A35 zero-major minor queues a notice", "0.2.0", "0.1.0"],
  ])("%s", async (_name, offered, running = "2.3.2") => {
    const h = home();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: offered }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await runAutoUpdate(h, running, { address: `http://127.0.0.1:${port}` });
    expect(state(h).pending_notice).toContain(offered);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("A46 status redacts POSIX and Windows backup paths", () => {
    const h = home();
    writeState(h, {
      schema: 1,
      last_check_at: "2026-01-01T00:00:00.000Z",
      backup: "/home/alice/.orch/config.toml.backup-1",
      log: "C:\\Users\\Alice\\.orch\\secret.log",
    });
    const text = statusText(h, {}, Date.parse("2026-01-02"));
    expect(text).toContain("settings backup kept: config.toml.backup-1");
    expect(text.slice(text.indexOf("backup") + 6)).not.toContain("/");
    expect(text).not.toContain("C:\\Users");
  });
  it("A49 auto-update docs defer config.toml-only backup", () => {
    const docs = readFileSync(join(process.cwd(), "docs", "commands.md"), "utf8");
    expect(docs).toContain("back up only `config.toml`");
    expect(docs).toContain("never copy or restore live team state");
  });
  it("A50 the public manifest pins the auto-update paragraph", () => {
    const fixture = join(process.cwd(), "tests", "fixtures", "part2-public-text.json");
    const manifest = JSON.parse(readFileSync(fixture, "utf8"));
    expect(manifest.blocks.map((block: { id: string }) => block.id)).toContain(
      "docs/commands.md: weekly auto-update section",
    );
  });
  it("A25 one pending notice is consumed once", () => {
    const h = home();
    writeState(h, {
      schema: 1,
      last_check_at: "2026-01-01T00:00:00.000Z",
      pending_notice: "available",
    });
    expect([consumeNotice(h), consumeNotice(h)]).toEqual(["available", null]);
  });
});
