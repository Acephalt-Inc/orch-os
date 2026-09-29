// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch schedule`: every test drives schedule.ts through an injected fake Host (a tmp `home`
 * and a recording `exec` stub), never the real OS. No test calls launchctl, systemctl or
 * crontab for real, and none writes outside its own tmp directory - CI stays render-only too.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CmdSpec } from "../src/args.js";
import * as S from "../src/schedule.js";
import { run, useTmpHome } from "./_helpers.js";

const cleanups: string[] = [];
afterEach(() => {
  // nothing to actually clean: fakeHost() dirs live under the OS tmp dir and vitest's own
  // teardown / the OS reclaims them; kept as a hook point if that ever needs to change.
  cleanups.length = 0;
});

type FakeHost = S.Host & { calls: [string, string[], string | undefined][] };

function fakeHost(overrides: Partial<S.Host> = {}, exec?: (cmd: string, args: string[], input?: string) => S.ExecResult): FakeHost {
  const calls: [string, string[], string | undefined][] = [];
  const home = mkdtempSync(join(tmpdir(), "orch-sched-t-"));
  cleanups.push(home);
  const host: FakeHost = {
    platform: "darwin",
    home,
    uid: 501,
    which: (cmd: string) => `/usr/bin/${cmd}`,
    exec: (cmd, args, input) => {
      calls.push([cmd, args, input]);
      return exec ? exec(cmd, args, input) : { status: 0, stdout: "", stderr: "" };
    },
    calls,
    ...overrides,
  };
  return host;
}

function ctxFor(host: S.Host): S.RunContext {
  return { home: host.home, orchBin: "/opt/orch/bin/orch", orchHome: "/opt/orch/home", logDir: join(host.home, "logs"),
    leaseSession: "lead", leaseEpoch: 1 };
}

const JOBS = S.CANDIDATES; // this checkout's two real candidates: lease-renew, load-sample

describe("ScheduleTest", () => {
  it("test_available_and_unavailable_partition_by_the_live_command_tree", () => {
    const tree: CmdSpec<any> = {
      name: "orch",
      help: "",
      sub: [
        { name: "lease", help: "", sub: [{ name: "renew", help: "", run: () => 0 }] },
        // no "load" leaf: this synthetic tree stands in for a build that dropped it
      ],
    };
    expect(S.available(tree).map((j) => j.id)).toEqual(["lease-renew"]);
    expect(S.unavailable(tree).map((j) => j.id)).toEqual(["load-sample"]);
  });

  it("test_available_against_the_real_build_tree_has_both_jobs", async () => {
    const { buildTree } = await import("../src/cli.js");
    const tree = buildTree();
    expect(S.available(tree).map((j) => j.id).sort()).toEqual(["lease-renew", "load-sample"]);
    expect(S.unavailable(tree)).toEqual([]);
  });

  it("test_launchd_plist_rendering", () => {
    const host = fakeHost({ platform: "darwin" });
    const ctx = ctxFor(host);
    const files = S.render("launchd", JOBS, ctx);
    expect(files).toHaveLength(2);
    const lease = files.find((f) => f.path.includes("lease-renew"))!;
    expect(lease.path).toBe(S.launchdPath(host.home, "lease-renew"));
    expect(lease.contents).toContain("<key>Label</key>");
    expect(lease.contents).toContain("<string>com.orch-os.schedule.lease-renew</string>");
    expect(lease.contents).toContain("<string>/opt/orch/bin/orch</string>");
    expect(lease.contents).toContain("<string>lease</string>");
    expect(lease.contents).toContain("<string>renew</string>");
    expect(lease.contents).toContain("<string>--session</string>\n    <string>lead</string>");
    expect(lease.contents).toContain("<string>--expected-epoch</string>\n    <string>1</string>");
    expect(lease.contents).toContain("<key>StartInterval</key>");
    expect(lease.contents).toContain("<integer>300</integer>"); // 5 minutes
    expect(lease.contents).toContain("<key>ORCH_HOME</key>");
    expect(lease.contents).toContain("<string>/opt/orch/home</string>");
    expect(lease.contents).toContain("StandardOutPath");

    const load = files.find((f) => f.path.includes("load-sample"))!;
    expect(load.contents).toContain("<string>load</string>");
    expect(load.contents).toContain("<integer>60</integer>"); // 1 minute
  });

  it("test_systemd_unit_and_timer_rendering", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = ctxFor(host);
    const files = S.render("systemd", JOBS, ctx);
    expect(files).toHaveLength(4); // 2 jobs x (service + timer)
    const svc = files.find((f) => f.path.endsWith("orch-os-schedule-load-sample.service"))!;
    expect(svc.path).toBe(join(S.systemdDir(host.home), "orch-os-schedule-load-sample.service"));
    expect(svc.contents).toContain("[Service]");
    expect(svc.contents).toContain("Type=oneshot");
    expect(svc.contents).toContain("ExecStart=/opt/orch/bin/orch load");
    expect(svc.contents).toContain("Environment=ORCH_HOME=/opt/orch/home");
    const leaseSvc = files.find((f) => f.path.endsWith("orch-os-schedule-lease-renew.service"))!;
    expect(leaseSvc.contents).toContain("ExecStart=/opt/orch/bin/orch lease renew --session lead --expected-epoch 1");

    const timer = files.find((f) => f.path.endsWith("orch-os-schedule-load-sample.timer"))!;
    expect(timer.contents).toContain("[Timer]");
    expect(timer.contents).toContain("OnUnitActiveSec=1min");
    expect(timer.contents).toContain("Persistent=true");
    expect(timer.contents).toContain("WantedBy=timers.target");

    const leaseTimer = files.find((f) => f.path.endsWith("orch-os-schedule-lease-renew.timer"))!;
    expect(leaseTimer.contents).toContain("OnUnitActiveSec=5min");
  });

  it("test_cron_fallback_rendering", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = ctxFor(host);
    const files = S.render("cron", JOBS, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].contents).toContain("BEGIN orch-os schedule");
    expect(files[0].contents).toContain("*/5 * * * * ORCH_HOME=/opt/orch/home /opt/orch/bin/orch lease renew --session lead --expected-epoch 1");
    expect(files[0].contents).toContain("*/1 * * * * ORCH_HOME=/opt/orch/home /opt/orch/bin/orch load");
    expect(files[0].contents).toContain("END orch-os schedule");
  });

  it("test_backend_detection_macos_is_always_launchd", () => {
    expect(S.detectBackend(fakeHost({ platform: "darwin" }))).toBe("launchd");
  });

  it("test_backend_detection_linux_falls_back_to_cron_without_systemctl", () => {
    const host = fakeHost({ platform: "linux", which: (c) => (c === "systemctl" ? null : `/usr/bin/${c}`) });
    expect(S.detectBackend(host)).toBe("cron");
  });

  it("test_backend_detection_linux_falls_back_to_cron_when_the_user_bus_is_unreachable", () => {
    const host = fakeHost({ platform: "linux" }, () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus\n" }));
    expect(S.detectBackend(host)).toBe("cron");
  });

  it("test_backend_detection_linux_uses_systemd_when_the_user_bus_answers", () => {
    const host = fakeHost({ platform: "linux" }, () => ({ status: 0, stdout: "running\n", stderr: "" }));
    expect(S.detectBackend(host)).toBe("systemd");
  });

  it("test_unsupported_platform_throws_schedule_error", () => {
    const host = fakeHost({ platform: "win32" as NodeJS.Platform });
    expect(() => S.detectBackend(host)).toThrow(S.ScheduleError);
  });

  it("test_dry_run_render_writes_and_execs_nothing", () => {
    const host = fakeHost();
    const ctx = ctxFor(host);
    S.render("launchd", JOBS, ctx);
    S.render("systemd", JOBS, ctx);
    S.render("cron", JOBS, ctx);
    expect(existsSync(S.launchdPath(host.home, "lease-renew"))).toBe(false);
    expect(existsSync(S.systemdDir(host.home))).toBe(false);
    expect(host.calls).toHaveLength(0); // rendering never shells out
  });

  it("test_install_launchd_writes_plists_and_bootstraps", () => {
    const host = fakeHost({ platform: "darwin" });
    const ctx = ctxFor(host);
    const rows = S.install("launchd", JOBS, ctx, host);
    expect(rows).toHaveLength(2);
    expect(existsSync(S.launchdPath(host.home, "lease-renew"))).toBe(true);
    expect(existsSync(S.launchdPath(host.home, "load-sample"))).toBe(true);
    expect(rows.every((r) => r.activated)).toBe(true);
    expect(host.calls.some((c) => c[0] === "launchctl" && c[1][0] === "bootstrap")).toBe(true);
    expect(host.calls.some((c) => c[0] === "launchctl" && c[1][0] === "bootout")).toBe(true);
  });

  it("test_status_and_remove_parse_launchd_state_correctly", () => {
    const host = fakeHost({ platform: "darwin" }, (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        return args[1].includes("lease-renew") ? { status: 0, stdout: "", stderr: "" } : { status: 3, stdout: "", stderr: "Could not find service\n" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("launchd", JOBS, ctx, host);
    let rows = S.status("launchd", JOBS, ctx, host);
    expect(rows.find((r) => r.id === "lease-renew")).toMatchObject({ written: true, loaded: true });
    expect(rows.find((r) => r.id === "load-sample")).toMatchObject({ written: true, loaded: false });

    const removed = S.remove("launchd", JOBS, ctx, host);
    expect(removed.every((r) => r.removed)).toBe(true);
    expect(existsSync(S.launchdPath(host.home, "lease-renew"))).toBe(false);
    rows = S.status("launchd", JOBS, ctx, host);
    expect(rows.every((r) => !r.written)).toBe(true);
  });

  it("test_status_and_remove_parse_systemd_state_correctly", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args) => {
      if (cmd === "systemctl" && args[0] === "--user" && args[1] === "is-active") {
        return args[2].includes("lease-renew") ? { status: 0, stdout: "active\n", stderr: "" } : { status: 3, stdout: "inactive\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("systemd", JOBS, ctx, host);
    let rows = S.status("systemd", JOBS, ctx, host);
    expect(rows.find((r) => r.id === "lease-renew")).toMatchObject({ written: true, loaded: true });
    expect(rows.find((r) => r.id === "load-sample")).toMatchObject({ written: true, loaded: false });

    const removed = S.remove("systemd", JOBS, ctx, host);
    expect(removed.every((r) => r.removed)).toBe(true);
    for (const j of JOBS) expect(existsSync(join(S.systemdDir(host.home), `${S.systemdUnitName(j.id)}.timer`))).toBe(false);
    rows = S.status("systemd", JOBS, ctx, host);
    expect(rows.every((r) => !r.written)).toBe(true);
  });

  it("test_status_and_remove_parse_cron_state_correctly", () => {
    let crontab = "";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return crontab ? { status: 0, stdout: crontab, stderr: "" } : { status: 1, stdout: "", stderr: "no crontab for user\n" };
      if (cmd === "crontab" && args[0] === "-") {
        crontab = input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("cron", JOBS, ctx, host);
    expect(crontab).toContain("BEGIN orch-os schedule");
    let rows = S.status("cron", JOBS, ctx, host);
    expect(rows.every((r) => r.loaded)).toBe(true);

    S.remove("cron", JOBS, ctx, host);
    expect(crontab).not.toContain("BEGIN orch-os schedule");
    rows = S.status("cron", JOBS, ctx, host);
    expect(rows.every((r) => !r.loaded)).toBe(true);
  });

  it("test_cron_install_and_remove_preserve_unrelated_existing_entries", () => {
    let crontab = "0 3 * * * /usr/bin/backup.sh\n";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      if (cmd === "crontab" && args[0] === "-") {
        crontab = input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("cron", JOBS, ctx, host);
    expect(crontab).toContain("backup.sh");
    expect(crontab).toContain("BEGIN orch-os schedule");

    S.remove("cron", JOBS, ctx, host);
    expect(crontab).toContain("backup.sh");
    expect(crontab).not.toContain("BEGIN orch-os schedule");
  });

  it("test_install_reinstall_is_idempotent_for_cron", () => {
    let crontab = "";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return crontab ? { status: 0, stdout: crontab, stderr: "" } : { status: 1, stdout: "", stderr: "no crontab for user\n" };
      if (cmd === "crontab" && args[0] === "-") {
        crontab = input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("cron", JOBS, ctx, host);
    S.install("cron", JOBS, ctx, host);
    expect(crontab.match(/BEGIN orch-os schedule/g)).toHaveLength(1);
  });

  it("test_crontab_read_error_refuses_install_without_replacing_existing_entries", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) =>
      args[0] === "-l"
        ? { status: 1, stdout: "", stderr: "permission denied\n" }
        : { status: 0, stdout: "", stderr: "" });
    expect(() => S.install("cron", JOBS.filter((j) => j.id === "load-sample"), ctxFor(host), host))
      .toThrow(S.ScheduleError);
    expect(host.calls.some(([cmd, args]) => cmd === "crontab" && args[0] === "-")).toBe(false);
  });
});

// `--backend cron` makes these deterministic and exec-free on any OS: dry-run only ever calls
// S.render (never S.install/status/remove), and cron rendering needs no OS probe, unlike the
// launchd/systemd auto-detect path.
describe("ScheduleCliTest", () => {
  const ctx = useTmpHome();

  it("test_dry_run_prints_unit_files_and_writes_nothing", async () => {
    expect((await run("init"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "lead"))[0]).toBe(0);
    const before = existsSync(join(ctx.home, "schedule"));
    const [code, out] = await run("schedule", "install", "--dry-run", "--backend", "cron", "--session", "lead");
    expect(code).toBe(0);
    expect(out).toContain("BEGIN orch-os schedule");
    expect(out).toContain("lease renew");
    expect(out).toContain("load");
    expect(existsSync(join(ctx.home, "schedule"))).toBe(before); // no logDir created by a dry run
  });

  it("test_invalid_backend_choice_is_a_usage_error", async () => {
    const [code, , err] = await run("schedule", "install", "--backend", "bogus");
    expect(code).toBe(2);
    expect(err).toContain("invalid choice");
  });

  it("test_doctor_reports_schedule_jobs_after_init", async () => {
    await run("init");
    const [code, out] = await run("doctor");
    expect(code).toBe(0);
    expect(out).toContain("schedule lease-renew");
    expect(out).toContain("schedule load-sample");
  });

  it("test_schedule_renewal_is_bound_to_the_acquired_session_and_epoch", async () => {
    expect((await run("init"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "lead"))[0]).toBe(0);

    const [code, out] = await run("schedule", "install", "--dry-run", "--backend", "cron", "--session", "lead");
    expect(code).toBe(0);
    expect(out).toContain("lease renew --session lead --expected-epoch 1");

    const [wrongCode, , wrongErr] = await run("schedule", "install", "--dry-run", "--backend", "cron", "--session", "other");
    expect(wrongCode).toBe(2);
    expect(wrongErr).toContain("current lease holder");
  });
});
