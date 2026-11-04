// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLock, LockTimeoutError, withLock } from "../src/lock.js";
import { useTmpHome } from "./_helpers.js";

describe("lead lock protection", () => {
  const ctx = useTmpHome();
  it("does not let an ordinary contender steal an old protected live lock", () => {
    const path = join(ctx.home, "protected.lock.d");
    const holder = new FileLock(path, { protectLive: true } as ConstructorParameters<typeof FileLock>[1]);
    holder.acquire();
    const ownerPath = join(path, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.created_ms = Date.now() - 120_000;
    writeFileSync(ownerPath, JSON.stringify(owner));
    expect.soft(owner.protect_live).toBe(true);
    expect(() => new FileLock(path, { timeoutMs: 80 }).acquire()).toThrow(LockTimeoutError);
    holder.release();
  });
  it("recovers a protected lock left by a dead local process", () => {
    const path = join(ctx.home, "dead.lock.d");
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 4194427, host: hostname(), token: "dead", created_ms: Date.now(), protect_live: true }));
    expect(withLock(path, () => "recovered", { timeoutMs: 2000 })).toBe("recovered");
  });
  it("retains ordinary stale-lock recovery", () => {
    const path = join(ctx.home, "legacy.lock.d");
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token: "old", created_ms: Date.now() - 120_000 }));
    expect(withLock(path, () => "recovered", { timeoutMs: 2000 })).toBe("recovered");
  });
});
