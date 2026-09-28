// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TaskError, Tasks } from "../src/tasks.js";
import { DIST_CLI, run, useTmpHome } from "./_helpers.js";

describe("TasksV2", () => {
  const ctx = useTmpHome();
  const reg = () => new Tasks(`${ctx.home}/tasks`, 7200, 60);

  it("task_ids_are_case_insensitive", () => {
    const t = new Tasks(`${ctx.home}/tasks`);
    expect(t.claim("Fix-1", "w1", { now: 1000 })[1].status).toBe("CLAIMED");
    const [code, r] = t.claim("fix-1", "w2", { now: 1001 });
    expect([code, r.status, r.task]).toEqual([3, "BUSY", "fix-1"]);
    expect(t.list(1002).map((x) => x.id)).toEqual(["fix-1"]);
    writeFileSync(`${ctx.home}/tasks/Stray.json`, "{}"); // not written by orch: ids are stored in lower case
    expect(t.list(1002).map((x) => x.id)).toEqual(["fix-1"]);
  });

  it("claim_is_exclusive_and_fenced_by_epoch", () => {
    let [code, r] = reg().claim("parser-fix", "w1", { now: 1000 });
    expect([code, r.status, r.state.epoch]).toEqual([0, "CLAIMED", 1]);
    [code, r] = reg().claim("parser-fix", "w2", { now: 1001 });
    expect([code, r.status, r.holder]).toEqual([3, "BUSY", "w1"]);
    [code, r] = reg().claim("parser-fix", "w1", { now: 1002 }); // extend own claim
    expect([code, r.status, r.state.epoch]).toEqual([0, "CLAIMED", 1]);
  });

  it("renew_and_release_check_holder_and_epoch", () => {
    reg().claim("t1", "w1", { now: 1000 });
    expect(reg().renew("t1", "w2", { now: 1001 })[1].status).toBe("NOT_HOLDER");
    expect(reg().renew("t1", "w1", { expectedEpoch: 2, now: 1001 })[1].status).toBe("STALE_EPOCH");
    expect(reg().renew("t1", "w1", { expectedEpoch: 1, now: 1001 })[0]).toBe(0);
    expect(reg().release("t1", "w2", { now: 1002 })[0]).toBe(4);
    expect(reg().release("t1", "w1", { expectedEpoch: 3, now: 1002 })[1].status).toBe("STALE_EPOCH");
    expect(reg().release("t1", "w1", { expectedEpoch: 1, now: 1002 })[1].status).toBe("RELEASED");
    const [code, r] = reg().claim("t1", "w2", { now: 1003 });
    expect([code, r.state.epoch, r.state.previous_owner]).toEqual([0, 2, "w1"]);
  });

  it("an_expired_claim_can_be_taken_and_fences_the_old_holder", () => {
    reg().claim("t2", "w1", { seconds: 60, now: 1000 });
    const [code, r] = reg().claim("t2", "w2", { now: 1061 });
    expect([code, r.state.epoch]).toEqual([0, 2]);
    expect(reg().renew("t2", "w1", { expectedEpoch: 1, now: 1062 })[1].status).toBe("NOT_HOLDER");
  });

  it("list_shows_every_task", () => {
    reg().claim("b-task", "w1", { now: Date.now() / 1000 });
    reg().claim("a-task", "w2", { seconds: 60, now: 1000 }); // long expired
    reg().claim("c-task", "w3", { now: Date.now() / 1000 });
    reg().release("c-task", "w3");
    const rows = reg().list();
    expect(rows.map((r) => [r.id, r.status, r.holder])).toEqual([
      ["a-task", "EXPIRED", "w2"], ["b-task", "CLAIMED", "w1"], ["c-task", "RELEASED", "w3"]]);
    expect(rows[1].expires_in).toBeGreaterThan(7000);
  });

  it("ids_and_holders_are_validated", () => {
    expect(() => reg().claim("../etc", "w1")).toThrow(TaskError);
    expect(() => reg().claim(".hidden", "w1")).toThrow(TaskError);
    expect(() => reg().claim("ok", "two words")).toThrow(TaskError);
  });

  it("concurrent_claims_from_processes_have_exactly_one_winner", async () => {
    await run("init", "--no-handbook");
    const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<number>((res) => {
      spawn(process.execPath, [DIST_CLI, "task", "claim", "hot", "--as", `w${i}`], {
        env: { ...process.env, ORCH_HOME: ctx.home }, stdio: "ignore",
      }).on("exit", (c) => res(c ?? -1));
    })));
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 3)).toHaveLength(7);
    const [, r] = reg().status("hot");
    expect(r.state.epoch).toBe(1);
  });
});

describe("TaskCliV2", () => {
  useTmpHome();

  it("cli_exit_codes_match_the_lease", async () => {
    await run("init", "--no-handbook");
    let [code, out] = await run("task", "claim", "t1", "--as", "w1");
    expect(code).toBe(0);
    expect(out).toMatch(/^task t1 CLAIMED holder=w1 epoch=1 expires_in=7\d{3}s\n$/);
    expect((await run("task", "claim", "t1", "--as", "w2"))[0]).toBe(3);
    expect((await run("task", "renew", "t1", "--as", "w1", "--expected-epoch", "9"))[0]).toBe(4);
    expect((await run("task", "release", "t1", "--as", "w2"))[0]).toBe(4);
    expect((await run("task", "claim", "bad/id", "--as", "w1"))[0]).toBe(2);
    [code, out] = await run("task", "list");
    expect(out).toMatch(/t1\s+CLAIMED\s+holder=w1 epoch=1/);
    [code, out] = await run("task", "status", "t1", "--json");
    expect(JSON.parse(out)).toMatchObject({ task: "t1", status: "HELD" });
    expect((await run("task", "release", "t1", "--as", "w1", "--expected-epoch", "1"))[0]).toBe(0);
  });
});
