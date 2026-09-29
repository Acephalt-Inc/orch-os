// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch schedule`: every test drives schedule.ts through an injected fake Host (a tmp `home`
 * and a recording `exec` stub), never the real OS. No test calls launchctl, systemctl or
 * crontab for real, and none writes outside its own tmp directory - CI stays render-only too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CmdSpec } from "../src/args.js";
import * as S from "../src/schedule.js";
import { DIST_CLI, run, useTmpHome } from "./_helpers.js";

const cleanups: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  return { home: host.home, nodeBin: process.execPath, orchBin: "/opt/orch/bin/orch", orchHome: "/opt/orch/home", logDir: join(host.home, "logs"),
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
    expect(lease.contents).toContain(`<string>${process.execPath}</string>\n    <string>/opt/orch/bin/orch</string>`);
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
    expect(svc.contents).toContain(`ExecStart=${process.execPath} /opt/orch/bin/orch load`);
    expect(svc.contents).toContain("Environment=ORCH_HOME=/opt/orch/home");
    const leaseSvc = files.find((f) => f.path.endsWith("orch-os-schedule-lease-renew.service"))!;
    expect(leaseSvc.contents).toContain(`ExecStart=${process.execPath} /opt/orch/bin/orch lease renew --session lead --expected-epoch 1`);

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
    expect(files[0].contents).toContain(`*/5 * * * * ORCH_HOME='/opt/orch/home' '${process.execPath}' '/opt/orch/bin/orch' 'lease' 'renew' '--session' 'lead' '--expected-epoch' '1'`);
    expect(files[0].contents).toContain(`*/1 * * * * ORCH_HOME='/opt/orch/home' '${process.execPath}' '/opt/orch/bin/orch' 'load'`);
    expect(files[0].contents).toContain("END orch-os schedule");
  });

  it("test_all_scheduled_jobs_start_with_absolute_node_not_shebang_path_lookup", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = ctxFor(host);
    const plist = S.render("launchd", [JOBS[1]], ctx)[0].contents;
    const service = S.render("systemd", [JOBS[1]], ctx)[0].contents;
    const cron = S.render("cron", [JOBS[1]], ctx)[0].contents;
    expect(plist).toContain(`<array>\n    <string>${process.execPath}</string>\n    <string>${ctx.orchBin}</string>`);
    expect(service).toContain(`ExecStart=${process.execPath} ${ctx.orchBin} load`);
    expect(cron).toContain(`'${process.execPath}' '${ctx.orchBin}' 'load'`);
  });

  it("test_backend_detection_macos_is_always_launchd", () => {
    expect(S.detectBackend(fakeHost({ platform: "darwin" }))).toBe("launchd");
  });

  it("test_backend_detection_linux_falls_back_to_cron_without_systemctl", () => {
    const host = fakeHost({ platform: "linux", which: (c) => (c === "systemctl" ? null : `/usr/bin/${c}`) });
    expect(S.detectBackend(host)).toBe("cron");
  });

  it("test_backend_detection_linux_falls_back_to_cron_when_the_user_bus_is_unreachable", () => {
    const host = fakeHost({ platform: "linux" }, (cmd) => cmd === "systemctl"
      ? { status: 1, stdout: "", stderr: "Failed to connect to bus\n" }
      : { status: 1, stdout: "", stderr: "no crontab for user\n" });
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
      if (cmd === "systemctl" && args[1] === "is-enabled") return { status: 0, stdout: "enabled\n", stderr: "" };
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

  it.each(["launchd", "systemd", "cron"] as const)(
    "test_loaded_jobs_with_missing_captured_node_are_error_not_healthy_on_%s", (backend) => {
      let crontab = "";
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args, input) => {
        if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
        if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 0, stdout: "enabled", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const captured = { ...ctxFor(host), nodeBin: join(host.home, "removed-node") };
      S.install(backend, [JOBS[1]], captured, host);
      const managed = S.render(backend, [JOBS[1]], captured)[0].path;
      const before = backend === "cron" ? crontab : readFileSync(managed, "utf8");
      const current = { ...captured, nodeBin: process.execPath }; // current Node works; the installed one does not
      const rows = S.status(backend, [JOBS[1]], current, host);
      expect(rows[0]).toMatchObject({ written: true, loaded: false, degraded: true });
      expect(rows[0].detail).toMatch(/removed-node.*(missing|not executable)/);
      expect(backend === "cron" ? crontab : readFileSync(managed, "utf8")).toBe(before);
    });

  it("test_legacy_shebang_invocations_are_unverifiable_not_healthy_on_all_backends", () => {
    for (const backend of ["launchd", "systemd", "cron"] as const) {
      let crontab = "";
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args, input) => {
        if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
        if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 0, stdout: "enabled", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      S.install(backend, [JOBS[1]], ctx, host);
      if (backend === "cron") {
        crontab = crontab.replace(`'${ctx.nodeBin}' '${ctx.orchBin}' 'load'`, `'${ctx.orchBin}' 'load'`);
      } else {
        const file = S.render(backend, [JOBS[1]], ctx)[0].path;
        const old = readFileSync(file, "utf8");
        const legacy = backend === "launchd"
          ? old.replace(`<string>${ctx.nodeBin}</string>\n    <string>${ctx.orchBin}</string>`,
            `<string>${ctx.orchBin}</string>\n    <string>load</string>`)
          : old.replace(/^ExecStart=.*$/m, `ExecStart=${ctx.orchBin} load`);
        writeFileSync(file, legacy);
      }
      const row = S.status(backend, [JOBS[1]], ctx, host)[0];
      expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
      expect(row.detail).toMatch(/no verifiable absolute Node/);
    }
  });

  it.each(["launchd", "systemd"] as const)(
    "test_loaded_job_missing_managed_%s_file_is_error_without_rewrite", (backend) => {
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args) => {
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      const file = backend === "launchd" ? S.launchdPath(host.home, JOBS[1].id)
        : join(S.systemdDir(host.home), `${S.systemdUnitName(JOBS[1].id)}.timer`);
      expect(existsSync(file)).toBe(false);
      const row = S.status(backend, [JOBS[1]], ctx, host)[0];
      expect(row).toMatchObject({ written: false, loaded: false, degraded: true });
      expect(row.detail).toMatch(/managed .* file missing/);
      expect(existsSync(file)).toBe(false);
    });

  it("test_active_but_disabled_systemd_timer_is_degraded", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args) => {
      if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
      if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 1, stdout: "disabled", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    for (const file of S.render("systemd", [JOBS[1]], ctx)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents);
    }
    const row = S.status("systemd", [JOBS[1]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
    expect(row.detail).toMatch(/timer is not enabled/);
  });

  it("test_active_systemd_timer_with_unknown_enablement_is_degraded", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args) => {
      if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
      if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 1, stdout: "", stderr: "user bus unavailable" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    for (const file of S.render("systemd", [JOBS[1]], ctx)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents);
    }
    const row = S.status("systemd", [JOBS[1]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
    expect(row.detail).toMatch(/cannot inspect timer enablement.*user bus unavailable/);
  });

  it.each(["launchd", "systemd"] as const)(
    "test_installed_%s_job_with_manager_inspection_error_is_degraded", (backend) => {
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args) => {
        if (cmd === "launchctl" && args.includes("print")) return { status: 5, stdout: "", stderr: "permission denied" };
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 1, stdout: "", stderr: "user bus unavailable" };
        return { status: 0, stdout: "enabled", stderr: "" };
      });
      const ctx = ctxFor(host);
      for (const file of S.render(backend, [JOBS[1]], ctx)) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.contents);
      }
      const row = S.status(backend, [JOBS[1]], ctx, host)[0];
      expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
      expect(row.detail).toMatch(/permission denied|user bus unavailable/);
    });

  it("test_inactive_systemd_job_with_unknown_enablement_is_degraded", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args) => {
      if (cmd === "systemctl" && args.includes("is-active")) return { status: 3, stdout: "inactive", stderr: "" };
      if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 1, stdout: "", stderr: "user bus unavailable" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    for (const file of S.render("systemd", [JOBS[1]], ctx)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents);
    }
    const row = S.status("systemd", [JOBS[1]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
    expect(row.detail).toMatch(/cannot inspect timer enablement.*user bus unavailable/);
  });

  it("test_searchable_directory_is_not_a_node_executable", () => {
    const host = fakeHost({ platform: "darwin" }, () => ({ status: 0, stdout: "", stderr: "" }));
    const ctx = { ...ctxFor(host), nodeBin: host.home }; // directory has X_OK on POSIX
    S.install("launchd", [JOBS[1]], ctx, host);
    const row = S.status("launchd", [JOBS[1]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
    expect(row.detail).toMatch(/not a regular executable file/);
  });

  it("test_cron_percent_escaped_node_path_round_trips_to_existing_executable", () => {
    let crontab = "";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
      if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    });
    const nodeBin = join(host.home, "node%run");
    symlinkSync(process.execPath, nodeBin);
    const ctx = { ...ctxFor(host), nodeBin };
    S.install("cron", [JOBS[1]], ctx, host);
    expect(crontab).toContain("node\\%run");
    const row = S.status("cron", [JOBS[1]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: true, degraded: false });
  });

  it.each(["launchd", "systemd", "cron"] as const)(
    "test_loaded_%s_job_targeting_wrong_cli_is_error", (backend) => {
      let crontab = "";
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args, input) => {
        if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
        if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 0, stdout: "enabled", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const installed = { ...ctxFor(host), orchBin: "/opt/other/cli.js" };
      S.install(backend, [JOBS[1]], installed, host);
      const current = { ...installed, orchBin: "/opt/orch/bin/orch" };
      const row = S.status(backend, [JOBS[1]], current, host)[0];
      expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
      expect(row.detail).toMatch(/installed CLI does not match/);
    });

  it.each(["launchd", "systemd", "cron"] as const)(
    "test_loaded_%s_lease_job_missing_epoch_is_error", (backend) => {
      let crontab = "";
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args, input) => {
        if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
        if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 0, stdout: "enabled", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      S.install(backend, [JOBS[0]], ctx, host);
      if (backend === "cron") {
        crontab = crontab.replace(" '--expected-epoch' '1'", "");
      } else {
        const file = S.render(backend, [JOBS[0]], ctx)[0].path;
        const old = readFileSync(file, "utf8");
        writeFileSync(file, backend === "launchd"
          ? old.replace("    <string>--expected-epoch</string>\n    <string>1</string>\n", "")
          : old.replace(" --expected-epoch 1", ""));
      }
      const row = S.status(backend, [JOBS[0]], ctx, host)[0];
      expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
      expect(row.detail).toMatch(/managed command arguments/);
    });

  it.each([
    ["invalid session", "<string>lead</string>", "<string>bad session</string>"],
    ["zero epoch", "<string>1</string>", "<string>0</string>"],
    ["wrong command", "<string>renew</string>", "<string>release</string>"],
  ])("test_loaded_launchd_lease_job_rejects_%s", (_case, from, to) => {
    const host = fakeHost({ platform: "darwin" });
    const ctx = ctxFor(host);
    S.install("launchd", [JOBS[0]], ctx, host);
    const file = S.launchdPath(host.home, JOBS[0].id);
    const original = readFileSync(file, "utf8");
    expect(original).toContain(from);
    writeFileSync(file, original.replace(from, to));
    const row = S.status("launchd", [JOBS[0]], ctx, host)[0];
    expect(row).toMatchObject({ written: true, loaded: false, degraded: true });
    expect(row.detail).toMatch(/managed command arguments/);
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

  it.each([
    ["empty", "", "empty"],
    ["no trailing newline", "0 3 * * * /usr/bin/backup.sh", "nonl"],
    ["trailing newline", "0 3 * * * /usr/bin/backup.sh\n", "nl"],
    ["whitespace only", " \t  ", "nonl"],
    ["blank lines", "\n \t\n\n", "nl"],
    ["user environment", "CRON_TZ=UTC\nMAILTO=ops@example.org\n0 3 * * * /usr/bin/backup.sh\n", "nl"],
  ])("test_cron_versioned_tail_roundtrip_%s", (_case, original, tail) => {
    let crontab = original;
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      if (cmd === "crontab" && args[0] === "-") {
        crontab = input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    S.install("cron", [JOBS[1]], ctx, host);
    const installed = crontab;
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain(`# BEGIN orch-os schedule v1 tail=${tail}`);
    expect(installed).toContain("# END orch-os schedule v1");
    expect(installed.match(/BEGIN orch-os schedule/g)).toHaveLength(1);
    if (tail === "nonl") expect(installed.slice(original.length, original.length + 1)).toBe("\n");
    S.install("cron", [JOBS[1]], ctx, host);
    expect(crontab).toBe(installed);
    S.remove("cron", [JOBS[1]], ctx, host);
    expect(crontab).toBe(original);
  });

  it.each([
    "# BEGIN orch-os schedule (managed by `orch schedule`; do not edit by hand)\n# END orch-os schedule\n",
    "# BEGIN orch-os schedule v2 tail=nl\n# END orch-os schedule v2\n",
    "# BEGIN orch-os schedule v1 tail=wat\n# END orch-os schedule v1\n",
  ])("test_cron_unknown_or_unversioned_markers_fail_closed", (original) => {
    let crontab = original;
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      crontab = input ?? "";
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    expect(() => S.install("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(() => S.status("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(() => S.remove("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(crontab).toBe(original);
    expect(host.calls.some(([, args]) => args[0] === "-")).toBe(false);
  });

  it("test_cron_tail_metadata_mismatch_is_not_reported_healthy", () => {
    const original = "MAILTO=ops@example.org\n# BEGIN orch-os schedule v1 tail=empty\n# END orch-os schedule v1\n";
    const host = fakeHost({ platform: "linux" }, (_cmd, args) => args[0] === "-l"
      ? { status: 0, stdout: original, stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    const ctx = ctxFor(host);
    expect(() => S.status("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(() => S.remove("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(host.calls.some(([, args]) => args[0] === "-")).toBe(false);
  });

  it.each([" ", "\t"])("test_indented_unknown_cron_marker_refuses_every_operation_%j", (indent) => {
    let crontab = `${indent}# BEGIN orch-os schedule v2 tail=empty\n`
      + "*/1 * * * * '/old/node' '/old/cli' 'load' >>'/tmp/old.log' 2>&1\n"
      + `${indent}# END orch-os schedule v2\n`;
    const original = crontab;
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      crontab = input ?? "";
      return { status: 0, stdout: "", stderr: "" };
    });
    const ctx = ctxFor(host);
    expect(() => S.installedBackend(host)).toThrow(/malformed.*managed block/i);
    expect(() => S.status("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(() => S.remove("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(() => S.install("cron", [JOBS[1]], ctx, host)).toThrow(/malformed.*managed block/i);
    expect(crontab).toBe(original);
    expect(crontab.match(/BEGIN orch-os schedule/g)).toHaveLength(1);
    expect(host.calls.some(([, args]) => args[0] === "-")).toBe(false);
  });

  it.each(["15 4 * * * /usr/bin/backup-b\n", "\n"])(
    "test_nonl_cron_tail_with_post_block_suffix_refuses_remove_and_reinstall_%j", (suffix) => {
      let crontab = "0 3 * * * /usr/bin/backup";
      const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
        if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
        crontab = input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      S.install("cron", [JOBS[1]], ctx, host);
      expect(crontab).toContain("tail=nonl");
      crontab += suffix;
      const original = crontab;
      const writesBefore = host.calls.filter(([, args]) => args[0] === "-").length;
      expect(() => S.remove("cron", [JOBS[1]], ctx, host)).toThrow(/post-block.*manual/i);
      expect(() => S.install("cron", [JOBS[1]], ctx, host)).toThrow(/post-block.*manual/i);
      expect(crontab).toBe(original);
      expect(crontab.match(/BEGIN orch-os schedule/g)).toHaveLength(1);
      expect(host.calls.filter(([, args]) => args[0] === "-")).toHaveLength(writesBefore);
    },
  );

  it("test_crontab_read_error_refuses_install_without_replacing_existing_entries", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) =>
      args[0] === "-l"
        ? { status: 1, stdout: "", stderr: "permission denied\n" }
        : { status: 0, stdout: "", stderr: "" });
    expect(() => S.install("cron", JOBS.filter((j) => j.id === "load-sample"), ctxFor(host), host))
      .toThrow(S.ScheduleError);
    expect(host.calls.some(([cmd, args]) => cmd === "crontab" && args[0] === "-")).toBe(false);
  });

  it("test_malformed_cron_block_never_erases_following_user_job", () => {
    const original = "# BEGIN orch-os schedule (managed by `orch schedule`; do not edit by hand)\n0 4 * * * /usr/bin/my-backup\n";
    let crontab = original;
    const host = fakeHost({ platform: "linux" }, (_cmd, args, input) => {
      if (args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      crontab = input ?? "";
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(() => S.install("cron", JOBS, ctxFor(host), host)).toThrow(/malformed.*managed block/i);
    expect(() => S.remove("cron", JOBS, ctxFor(host), host)).toThrow(/malformed.*managed block/i);
    expect(crontab).toBe(original);
    expect(host.calls.some(([, args]) => args[0] === "-")).toBe(false);
  });

  it("test_remove_preserves_unrelated_crontab_blank_lines_byte_for_byte", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    });
    const prefix = "0 3 * * * /usr/bin/backup-a\n\n\n";
    const suffix = "\n\n15 4 * * * /usr/bin/backup-b\n\n\n";
    let crontab = prefix;
    S.install("cron", [JOBS[1]], ctxFor(host), host);
    crontab += suffix;
    S.remove("cron", [JOBS[1]], ctxFor(host), host);
    expect(crontab).toBe(prefix + suffix);
  });

  it("test_install_refuses_unmanaged_launchd_target_without_activation", () => {
    const host = fakeHost({ platform: "darwin" });
    const ctx = ctxFor(host);
    const file = S.launchdPath(host.home, JOBS[1].id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "personal plist\n");
    expect(() => S.install("launchd", [JOBS[1]], ctx, host)).toThrow(/not a managed orch-os/);
    expect(readFileSync(file, "utf8")).toBe("personal plist\n");
    expect(host.calls).toHaveLength(0);
  });

  it("test_install_refuses_launchd_symlink_without_overwriting_target", () => {
    const host = fakeHost({ platform: "darwin" });
    const ctx = ctxFor(host);
    const file = S.launchdPath(host.home, JOBS[1].id);
    const target = join(host.home, "personal.txt");
    const targetBefore = S.render("launchd", [JOBS[1]], ctx)[0].contents + "<!-- old managed copy elsewhere -->\n";
    writeFileSync(target, targetBefore);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(target, file);
    expect(() => S.install("launchd", [JOBS[1]], ctx, host)).toThrow(/symbolic link|not a regular/);
    expect(readFileSync(target, "utf8")).toBe(targetBefore);
    expect(host.calls).toHaveLength(0);
  });

  it("test_systemd_install_checks_both_targets_before_overwriting_either", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = ctxFor(host);
    const [service, timer] = S.render("systemd", [JOBS[1]], ctx);
    mkdirSync(dirname(service.path), { recursive: true });
    const managedOld = service.contents + "# old managed comment\n";
    writeFileSync(service.path, managedOld);
    writeFileSync(timer.path, "personal timer\n");
    expect(() => S.install("systemd", [JOBS[1]], ctx, host)).toThrow(/not a managed orch-os/);
    expect(readFileSync(service.path, "utf8")).toBe(managedOld);
    expect(readFileSync(timer.path, "utf8")).toBe("personal timer\n");
    expect(host.calls).toHaveLength(0);
  });

  it("test_systemd_install_refuses_service_symlink_without_touching_timer", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = ctxFor(host);
    const [service, timer] = S.render("systemd", [JOBS[1]], ctx);
    mkdirSync(dirname(service.path), { recursive: true });
    const target = join(host.home, "personal.txt");
    const targetBefore = service.contents + "# old managed copy elsewhere\n";
    writeFileSync(target, targetBefore);
    symlinkSync(target, service.path);
    writeFileSync(timer.path, timer.contents + "# old managed comment\n");
    const timerOld = readFileSync(timer.path, "utf8");
    expect(() => S.install("systemd", [JOBS[1]], ctx, host)).toThrow(/symbolic link|not a regular/);
    expect(readFileSync(target, "utf8")).toBe(targetBefore);
    expect(readFileSync(timer.path, "utf8")).toBe(timerOld);
    expect(host.calls).toHaveLength(0);
  });

  it("test_remove_surfaces_os_deactivation_and_crontab_write_failures", () => {
    const launchd = fakeHost({ platform: "darwin" }, (_cmd, args) => args[0] === "bootout"
      ? { status: 5, stdout: "", stderr: "permission denied" } : { status: 0, stdout: "", stderr: "" });
    const launchCtx = ctxFor(launchd);
    const file = S.launchdPath(launchd.home, "load-sample");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, S.render("launchd", [JOBS[1]], launchCtx)[0].contents);
    expect(() => S.remove("launchd", [JOBS[1]], launchCtx, launchd)).toThrow(/permission denied/);
    expect(existsSync(file)).toBe(true);

    const systemd = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("disable")
      ? { status: 6, stdout: "", stderr: "user bus denied" }
      : args.includes("is-active") ? { status: 0, stdout: "active", stderr: "" }
      : args.includes("is-enabled") ? { status: 0, stdout: "enabled", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    const timer = join(S.systemdDir(systemd.home), `${S.systemdUnitName("load-sample")}.timer`);
    mkdirSync(dirname(timer), { recursive: true });
    writeFileSync(timer, S.render("systemd", [JOBS[1]], ctxFor(systemd)).find((f) => f.path === timer)!.contents);
    expect(() => S.remove("systemd", [JOBS[1]], ctxFor(systemd), systemd)).toThrow(/user bus denied/);
    expect(existsSync(timer)).toBe(true);

    const cron = fakeHost({ platform: "linux" }, (_cmd, args) => args[0] === "-l"
      ? { status: 0, stdout: S.render("cron", [JOBS[1]], ctxFor(cron))[0].contents, stderr: "" }
      : { status: 13, stdout: "", stderr: "read-only crontab" });
    expect(() => S.remove("cron", [JOBS[1]], ctxFor(cron), cron)).toThrow(/read-only crontab/);
  });

  it("test_render_quotes_paths_with_spaces_and_shell_metacharacters", () => {
    const host = fakeHost({ platform: "linux" });
    const ctx = { ...ctxFor(host), nodeBin: "/opt/node tools/bin/node", orchBin: "/opt/orch tools/bin/orch",
      orchHome: "/tmp/orch's home", logDir: "/tmp/orch logs" };
    const svc = S.render("systemd", [JOBS[1]], ctx)[0].contents;
    expect(svc).toContain('ExecStart="/opt/node tools/bin/node" "/opt/orch tools/bin/orch" load');
    expect(svc).toContain('Environment="ORCH_HOME=/tmp/orch\'s home"');
    const cron = S.render("cron", [JOBS[1]], ctx)[0].contents;
    expect(cron).toContain("ORCH_HOME='/tmp/orch'\\''s home'");
    expect(cron).toContain("'/opt/node tools/bin/node' '/opt/orch tools/bin/orch' 'load'");
    expect(cron).toContain(">>'/tmp/orch logs/load-sample.log'");
    expect(S.render("systemd", [JOBS[1]], { ...ctx, orchBin: "/opt/$tools/orch" })[0].contents)
      .toContain('ExecStart="/opt/node tools/bin/node" /opt/$$tools/orch load');
  });

  it("test_built_js_entrypoint_is_executable", () => {
    expect(statSync(DIST_CLI).mode & 0o111).not.toBe(0);
    expect(S.resolveOrchBin("/usr/bin/unrelated-runner.js", fakeHost())).toBe(DIST_CLI);
  });

  it("test_built_js_runs_with_absolute_node_under_scheduler_minimal_path", () => {
    const home = fakeHost().home;
    const env = { HOME: home, PATH: home }; // an existing empty directory: no `node` by any install layout
    const shebang = spawnSync(DIST_CLI, ["--help"], { env, encoding: "utf8" });
    expect(shebang.status).not.toBe(0); // the reproduced failure: /usr/bin/env cannot find node
    const explicitNode = spawnSync(process.execPath, [DIST_CLI, "--help"], { env, encoding: "utf8" });
    expect(explicitNode.error).toBeUndefined();
    expect(explicitNode.status).toBe(0);
    expect(explicitNode.stdout).toContain("orch");
  });

  it("test_install_activation_failure_is_reported_for_nonzero_exit", () => {
    const host = fakeHost({ platform: "darwin" }, (_cmd, args) => args[0] === "bootstrap"
      ? { status: 9, stdout: "", stderr: "bootstrap refused" } : { status: 0, stdout: "", stderr: "" });
    const rows = S.install("launchd", [JOBS[1]], ctxFor(host), host);
    expect(rows[0].activated).toBe(false);
    expect(S.installExitCode(rows)).not.toBe(0);
  });

  it("test_systemd_install_refuses_failed_reload_before_enabling_timer", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("daemon-reload")
      ? { status: 7, stdout: "", stderr: "reload denied" } : { status: 0, stdout: "", stderr: "" });
    expect(() => S.install("systemd", [JOBS[1]], ctxFor(host), host)).toThrow(/reload denied/);
    expect(host.calls.some(([, args]) => args.includes("enable"))).toBe(false);
  });

  it("test_remove_deactivates_loaded_job_even_when_unit_file_is_missing", () => {
    const launchd = fakeHost({ platform: "darwin" }, (_cmd, args) => args[0] === "print"
      ? { status: 0, stdout: "loaded", stderr: "" } : { status: 0, stdout: "", stderr: "" });
    const launchRows = S.remove("launchd", [JOBS[1]], ctxFor(launchd), launchd);
    expect(launchRows[0].removed).toBe(true);
    expect(launchd.calls.some(([, args]) => args[0] === "bootout")).toBe(true);

    const systemd = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("is-active")
      ? { status: 0, stdout: "active", stderr: "" }
      : args.includes("is-enabled") ? { status: 0, stdout: "enabled", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    const systemdRows = S.remove("systemd", [JOBS[1]], ctxFor(systemd), systemd);
    expect(systemdRows[0].removed).toBe(true);
    expect(systemd.calls.some(([, args]) => args.includes("disable"))).toBe(true);
  });

  it("test_remove_fails_closed_on_unknown_manager_state", () => {
    const launchd = fakeHost({ platform: "darwin" }, (_cmd, args) => args[0] === "print"
      ? { status: 13, stdout: "", stderr: "user domain unavailable" } : { status: 0, stdout: "", stderr: "" });
    expect(() => S.remove("launchd", [JOBS[1]], ctxFor(launchd), launchd)).toThrow(/user domain unavailable/);
    const systemd = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("is-active")
      ? { status: null, stdout: "", stderr: "bus unavailable" } : { status: 0, stdout: "", stderr: "" });
    expect(() => S.remove("systemd", [JOBS[1]], ctxFor(systemd), systemd)).toThrow(/bus unavailable/);
  });

  it("test_remove_disables_enabled_inactive_timer_without_unit_files", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("is-active")
      ? { status: 3, stdout: "inactive", stderr: "" }
      : args.includes("is-enabled") ? { status: 0, stdout: "enabled", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    const rows = S.remove("systemd", [JOBS[1]], ctxFor(host), host);
    expect(rows[0].removed).toBe(true);
    expect(host.calls.some(([, args]) => args.includes("disable"))).toBe(true);
  });

  it("test_remove_fails_closed_when_timer_enablement_is_unknown", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("is-active")
      ? { status: 3, stdout: "inactive", stderr: "" }
      : args.includes("is-enabled") ? { status: null, stdout: "", stderr: "bus unavailable" }
      : { status: 0, stdout: "", stderr: "" });
    expect(() => S.remove("systemd", [JOBS[1]], ctxFor(host), host)).toThrow(/bus unavailable/);
  });

  it("test_remove_reports_skip_when_systemd_timer_is_confirmed_absent", () => {
    const host = fakeHost({ platform: "linux" }, (_cmd, args) => args.includes("is-active") || args.includes("is-enabled")
      ? { status: 4, stdout: "not-found", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    const rows = S.remove("systemd", [JOBS[1]], ctxFor(host), host);
    expect(rows[0].removed).toBe(false);
    expect(host.calls.some(([, args]) => args.includes("disable"))).toBe(false);
  });

  it("test_backend_auto_selection_refuses_cron_when_systemd_units_exist", () => {
    const host = fakeHost({ platform: "linux" }, (cmd) => cmd === "systemctl"
      ? { status: 1, stdout: "", stderr: "Failed to connect to bus" }
      : { status: 1, stdout: "", stderr: "no crontab for user" });
    const unit = join(S.systemdDir(host.home), `${S.systemdUnitName("load-sample")}.timer`);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "existing timer");
    expect(() => S.detectBackend(host)).toThrow(/systemd.*unavailable/i);
  });

  it("test_backend_auto_selection_keeps_existing_cron_after_user_bus_returns", () => {
    const host = fakeHost({ platform: "linux" }, (cmd, args) => cmd === "systemctl"
      ? { status: 0, stdout: "running", stderr: "" }
      : { status: 0, stdout: S.render("cron", [JOBS[1]], ctxFor(host))[0].contents, stderr: "" });
    expect(S.detectBackend(host)).toBe("cron");
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
    expect(out).toContain("'lease' 'renew'");
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

  it("test_doctor_fails_when_installed_systemd_backend_cannot_be_inspected", async () => {
    expect((await run("init"))[0]).toBe(0);
    const host = fakeHost({ platform: "linux" }, (cmd, args) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 1, stdout: "", stderr: "no crontab for user" };
      if (cmd === "systemctl" && args.includes("is-system-running")) return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(S, "realHost").mockReturnValue(host);
    const timer = S.render("systemd", [JOBS[1]], ctxFor(host)).find((f) => f.path.endsWith(".timer"))!;
    mkdirSync(dirname(timer.path), { recursive: true });
    writeFileSync(timer.path, timer.contents);
    const [code, out] = await run("doctor");
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+schedule\s+.*systemd user bus unavailable/);
  });

  it("test_doctor_skips_genuinely_unsupported_platform", async () => {
    expect((await run("init"))[0]).toBe(0);
    vi.spyOn(S, "realHost").mockReturnValue(fakeHost({ platform: "win32" }));
    const [code, out] = await run("doctor");
    expect(code).toBe(0);
    expect(out).toMatch(/SKIP\s+schedule\s+no backend for this platform/);
  });

  it("test_unavailable_but_installed_candidate_is_error_and_removable", async () => {
    expect((await run("init"))[0]).toBe(0);
    let crontab = "0 3 * * * /usr/bin/backup.sh\n";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
      if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    });
    S.install("cron", [JOBS[1]], ctxFor(host), host);
    vi.spyOn(S, "realHost").mockReturnValue(host);
    vi.spyOn(S, "available").mockReturnValue([JOBS[0]]);
    vi.spyOn(S, "unavailable").mockReturnValue([JOBS[1]]);
    const [statusCode, statusOut] = await run("schedule", "status", "--backend", "cron");
    expect(statusCode).toBe(1);
    expect(statusOut).toMatch(/ERROR\s+load-sample.*no `orch load` subcommand/);
    const [removeCode] = await run("schedule", "remove", "--backend", "cron");
    expect(removeCode).toBe(0);
    expect(crontab).toContain("/usr/bin/backup.sh");
    expect(crontab).not.toContain("BEGIN orch-os schedule");
    S.install("cron", [JOBS[0]], { ...ctxFor(host), orchBin: DIST_CLI }, host);
    const [availableCode, availableOut] = await run("schedule", "status", "--backend", "cron");
    expect(availableCode).toBe(0);
    expect(availableOut).toMatch(/N\/A\s+load-sample.*not scheduled/);
  });

  it.each(["launchd", "systemd"] as const)(
    "test_remove_refuses_unmanaged_same_path_%s_file", (backend) => {
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args) => {
        if (cmd === "launchctl" && args.includes("print")) return { status: 1, stdout: "", stderr: "service not found" };
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 4, stdout: "not-found", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 4, stdout: "not-found", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      const file = backend === "launchd" ? S.launchdPath(host.home, JOBS[1].id)
        : join(S.systemdDir(host.home), `${S.systemdUnitName(JOBS[1].id)}.service`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "personal configuration; not an orch-os managed file\n");
      expect(() => S.remove(backend, [JOBS[1]], ctx, host)).toThrow(/not a managed orch-os/);
      expect(readFileSync(file, "utf8")).toBe("personal configuration; not an orch-os managed file\n");
      expect(host.calls.some(([cmd, args]) => cmd === "launchctl" && args.includes("bootout")
        || cmd === "systemctl" && args.includes("disable"))).toBe(false);
    });

  it.each(["launchd", "systemd"] as const)(
    "test_remove_refuses_mismatched_command_in_%s_managed_label_file", (backend) => {
      const host = fakeHost({ platform: backend === "launchd" ? "darwin" : "linux" }, (cmd, args) => {
        if (cmd === "systemctl" && args.includes("is-active")) return { status: 0, stdout: "active", stderr: "" };
        if (cmd === "systemctl" && args.includes("is-enabled")) return { status: 0, stdout: "enabled", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const ctx = ctxFor(host);
      const file = S.render(backend, [JOBS[1]], ctx).find((f) => backend === "launchd" || f.path.endsWith(".service"))!;
      const original = file.contents;
      const altered = backend === "launchd" ? original.replace("<string>load</string>", "<string>task</string>")
        : original.replace(/ load\n/, " task\n");
      expect(altered).not.toBe(original);
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, altered);
      expect(() => S.remove(backend, [JOBS[1]], ctx, host)).toThrow(/not a managed orch-os/);
      expect(readFileSync(file.path, "utf8")).toBe(altered);
      expect(host.calls.some(([cmd, args]) => cmd === "launchctl" && args.includes("bootout")
        || cmd === "systemctl" && args.includes("disable"))).toBe(false);
    });

  it("test_status_and_doctor_return_nonzero_for_loaded_job_with_missing_captured_node", async () => {
    expect((await run("init"))[0]).toBe(0);
    let crontab = "";
    const host = fakeHost({ platform: "linux" }, (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { status: crontab ? 0 : 1, stdout: crontab, stderr: crontab ? "" : "no crontab for user" };
      if (cmd === "crontab" && args[0] === "-") { crontab = input ?? ""; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "running", stderr: "" };
    });
    vi.spyOn(S, "realHost").mockReturnValue(host);
    const missingNode = join(host.home, "removed-node");
    S.install("cron", JOBS, { home: host.home, nodeBin: missingNode, orchBin: DIST_CLI,
      logDir: join(host.home, "logs"), leaseSession: "lead", leaseEpoch: 1 }, host);
    const [statusCode, statusOut] = await run("schedule", "status", "--backend", "cron");
    expect(statusCode).toBe(1);
    expect(statusOut).toContain("ERROR");
    expect(statusOut).toContain("removed-node");
    const [doctorCode, doctorOut] = await run("doctor");
    expect(doctorCode).toBe(1);
    expect(doctorOut).toContain("FAIL  schedule lease-renew");
    expect(doctorOut).toContain("removed-node");
  });

  it("test_schedule_renewal_is_bound_to_the_acquired_session_and_epoch", async () => {
    expect((await run("init"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "lead"))[0]).toBe(0);

    const [code, out] = await run("schedule", "install", "--dry-run", "--backend", "cron", "--session", "lead");
    expect(code).toBe(0);
    expect(out).toContain("'lease' 'renew' '--session' 'lead' '--expected-epoch' '1'");

    const [wrongCode, , wrongErr] = await run("schedule", "install", "--dry-run", "--backend", "cron", "--session", "other");
    expect(wrongCode).toBe(2);
    expect(wrongErr).toContain("current lease holder");
  });

  it("test_cli_install_returns_nonzero_when_activation_fails", async () => {
    expect((await run("init"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "lead"))[0]).toBe(0);
    const host = fakeHost({ platform: "darwin" }, (_cmd, args) => args[0] === "bootstrap"
      ? { status: 9, stdout: "", stderr: "bootstrap refused" } : { status: 0, stdout: "", stderr: "" });
    vi.spyOn(S, "realHost").mockReturnValue(host);
    const [code, out] = await run("schedule", "install", "--backend", "launchd", "--session", "lead");
    expect(code).toBe(2);
    expect(out).toContain("bootstrap refused");
  });

  it("test_cli_refuses_explicit_backend_switch_until_old_jobs_are_removed", async () => {
    expect((await run("init"))[0]).toBe(0);
    expect((await run("lease", "acquire", "--session", "lead"))[0]).toBe(0);
    const host = fakeHost({ platform: "linux" }, (cmd) => cmd === "crontab"
      ? { status: 0, stdout: S.render("cron", [JOBS[1]], ctxFor(host))[0].contents, stderr: "" }
      : { status: 0, stdout: "running", stderr: "" });
    vi.spyOn(S, "realHost").mockReturnValue(host);
    const [code, , err] = await run("schedule", "install", "--backend", "systemd", "--session", "lead");
    expect(code).toBe(2);
    expect(err).toContain("remove --backend cron");
    expect(host.calls.some(([cmd, args]) => cmd === "systemctl" && args.includes("enable"))).toBe(false);
  });
});
