import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { Messages } from "../src/messages.js";
import { useTmpHome } from "./_helpers.js";

const ctx = useTmpHome();
async function run(argv: string[], platform: NodeJS.Platform = "darwin") {
  let out = "", err = "";
  const calls: unknown[] = [];
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "" }, {
    platform, service: { userHome: join(ctx.home, "user"), uid: 42, user: "operator", runner: (cmd: string, args: string[]) => { calls.push([cmd, args]); return { code: 1, out: "", err: "not found" }; } },
  } as never);
  return { code, out, err, calls };
}
describe("service CLI", () => {
  it("shows help before reading configuration", async () => {
    writeFileSync(join(ctx.home, "config.toml"), "bad toml!!!");
    const r = await run(["service", "--help"]);
    expect(r.code).toBe(0); expect(r.out).toContain("install"); expect(r.calls).toEqual([]);
  });
  it.each(["darwin", "win32"] as const)("dry-run install on %s writes nothing", async (platform) => {
    const r = await run(["service", "install", "--dry-run"], platform);
    expect(r.code).toBe(0); expect(r.out).toContain("wake-watch");
    expect(readdirSync(ctx.home)).toEqual([]);
    expect(r.calls.every((c: any) => !["bootstrap", "/Create", "/Delete", "bootout"].includes(c[1][0]))).toBe(true);
  });
  it("reports Linux as typed UNAVAILABLE", async () => {
    const r = await run(["service", "status"], "linux");
    expect(r.code).toBe(1); expect(JSON.parse(r.out).outcome).toBe("UNAVAILABLE");
    expect(readdirSync(ctx.home)).toEqual([]); expect(r.calls).toEqual([]);
  });
  it("honors job disabling and refuses the deferred disk job", async () => {
    writeFileSync(join(ctx.home, "config.toml"), "[service]\nwake_watch = false\n");
    const r = await run(["service", "install"]);
    expect(r.code).toBe(0); expect(existsSync(join(ctx.home, "service"))).toBe(false);
    writeFileSync(join(ctx.home, "config.toml"), "[service]\ndisk = true\n");
    expect((await run(["service", "install"])).out).toContain("UNAVAILABLE");
    expect((await run(["service", "status"])).out).toContain("STATUS");
    expect((await run(["service", "uninstall", "--dry-run"])).out).toContain("DRY_RUN");
    writeFileSync(join(ctx.home, "config.toml"), '[service]\nwake_watch = "false"\n');
    expect((await run(["service", "install"])).code).toBe(2);
  });
  it("uses --home for ORCH_HOME placeholders even with a different inherited environment", async () => {
    const home = join(ctx.home, "scheduled"); mkdirSync(home);
    writeFileSync(join(home, "config.toml"), '[messages]\npath = "$ORCH_HOME/messages.jsonl"\n');
    new Messages(join(home, "messages.jsonl"), join(home, "cursors")).send("w", "lead", "DONE", "child home");
    expect((await run(["service", "run", "wake-watch", "--home", home, "--once"])).code).toBe(0);
    expect(readFileSync(join(home, "wake", "events.log"), "utf8")).toContain("child home");
  });
  it("runs one watcher pass with configured reader and --home, keeping the reader inbox unacked", async () => {
    writeFileSync(join(ctx.home, "config.toml"), '[service]\nreader = "boss"\n');
    const msg = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    msg.send("worker", "boss", "DONE", "completed");
    const r = await run(["service", "run", "wake-watch", "--home", ctx.home, "--once"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(ctx.home, "wake", "events.log"), "utf8")).toContain('"kind":"DONE"');
    expect(msg.pending("boss")).toHaveLength(1);
    expect((await run(["service", "run", "wake-watch", "--once"])).code).toBe(0);
    expect(readFileSync(join(ctx.home, "wake", "events.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

it.each(["darwin", "win32"] as const)("includes enabled health in the job roster on %s", async platform => {
  writeFileSync(join(ctx.home, "config.toml"), "[service]\nhealth = true\n");
  const r = await run(["service", "install", "--dry-run"], platform);
  expect(r.code).toBe(0); expect(r.out).toContain('health');
  expect(JSON.parse(r.out).plans).toHaveLength(2);
  expect((await run(["service", "status"], platform)).out).toContain('.health');
});
it("runs one health pass in the scheduled home and validates deadman configuration", async () => {
  const home = join(ctx.home, "scheduled"); mkdirSync(home);
  writeFileSync(join(home, "config.toml"), '[service]\ndeadman_seconds = 90\n');
  const r = await run(["service", "run", "health", "--home", home]);
  expect(r.code).toBe(0); expect(JSON.parse(r.out).stale).toBe(true);
  expect(existsSync(join(home, "wake", "health.json"))).toBe(true);
  writeFileSync(join(home, "config.toml"), '[service]\ndeadman_seconds = -1\n');
  expect((await run(["service", "run", "health", "--home", home])).code).toBe(2);
});
it('reports DRY_RUN when only health is enabled', async () => {
  writeFileSync(join(ctx.home, 'config.toml'), '[service]\nwake_watch = false\nhealth = true\n');
  const r = await run(['service', 'install', '--dry-run']);
  expect(JSON.parse(r.out).outcome).toBe('DRY_RUN');
  expect(JSON.parse(r.out).plans).toHaveLength(1);
  expect(readdirSync(ctx.home)).toEqual(['config.toml']);
});
