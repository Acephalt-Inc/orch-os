// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ROOT, keepEnv, run, useTmpHome } from "./_helpers.js";
import { CapError, isPublicIPv4, newUsageRow, readUsage, recordUsage, validateManifest } from "../src/cap.js";
import { main, type IO } from "../src/cli.js";

const manifest = {
  schema_version: 1,
  provider: {
    id: "fixture-provider", name: "Fixture Provider", base_url: "https://api.example.test",
    auth: { type: "bearer", env_var: "FIXTURE_API_KEY" },
  },
  capabilities: [{
    id: "example-task", description: "Fixture task", method: "POST", path: "/v1/example-task",
    pricing_unit: "credits", max_rows: 20, mode: "sync",
    input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false },
    output_envelope: "orch-cap-envelope-v1",
  }],
};
const envelope = {
  value: { rows: [{ id: "r1" }] }, unit: "record", method: "extracted",
  citations: [{ doc_id: "doc-1", page: 1, quote: "fixture quote" }], citations_truncated: false,
  confidence: 0.9,
  conflicts: [], conflicts_truncated: false,
  usage: { credits: 2, pages: 1, model_tokens: 0 },
};
const USAGE_LIMIT = 16 * 1024 * 1024;
const USAGE_EVENT_LIMIT = 2048;

function fillUsageLog(path: string, freeBytes: number): void {
  const prefix = '{"call_id":"padding","padding":"';
  const suffix = '"}\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, prefix + "x".repeat(USAGE_LIMIT - freeBytes - prefix.length - suffix.length) + suffix);
}

describe("cap local registry", () => {
  const ctx = useTmpHome();
  keepEnv(["FIXTURE_API_KEY", "AWS_SECRET_ACCESS_KEY"]);
  beforeEach(() => { delete process.env.FIXTURE_API_KEY; delete process.env.AWS_SECRET_ACCESS_KEY; });

  it("validates the checked-in fixture through the checked-in v1 JSON Schema", () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, "schemas", "fixtures", "cap-manifest-v1.json"), "utf8"));
    expect(validateManifest(fixture).capabilities[0].pricing_unit).toBe("credits");
    expect(() => validateManifest({ ...fixture, schema_version: 2 })).toThrow(/schema/);
  });

  it("has no default provider and adds, lists, then removes a validated file manifest", async () => {
    expect(await run("cap", "list")).toEqual([0, "providers: none\n", ""]);
    expect(await run("cap", "usage")).toEqual([0, "usage: none\n", ""]);
    const source = join(ctx.home, "manifest.json");
    writeFileSync(source, JSON.stringify(manifest));
    expect(await run("cap", "add", source)).toEqual([0, "added fixture-provider (Fixture Provider; 1 capability)\n", ""]);
    expect(await run("cap", "list")).toEqual([0, "fixture-provider  Fixture Provider  1 capability\n", ""]);
    expect((await run("cap", "add", source))[0]).toBe(2);
    expect(await run("cap", "remove", "fixture-provider")).toEqual([0, "removed fixture-provider\n", ""]);
    expect(await run("cap", "list")).toEqual([0, "providers: none\n", ""]);
  });

  it("rejects a malformed manifest with no registry change or secret persistence", async () => {
    const source = join(ctx.home, "manifest.json");
    const bad = structuredClone(manifest);
    bad.provider.auth.env_var = "literal-token-value?";
    writeFileSync(source, JSON.stringify(bad));
    const [code, , err] = await run("cap", "add", source);
    expect(code).toBe(2);
    expect(err).toContain("manifest");
    expect(existsSync(join(ctx.home, "cap", "registry.json"))).toBe(false);
  });

  it("rejects local and path-escaping provider URLs before any registry write", async () => {
    const source = join(ctx.home, "manifest.json");
    for (const [base, path] of [
      ["https://127.0.0.1", "/v1/example-task"],
      ["https://localhost", "/v1/example-task"],
      ["https://api.example.test", "/v1/%2e%2e/secret"],
    ]) {
      const bad = structuredClone(manifest);
      bad.provider.base_url = base;
      bad.capabilities[0].path = path;
      writeFileSync(source, JSON.stringify(bad));
      expect((await run("cap", "add", source))[0], `${base}${path}`).toBe(2);
      expect(existsSync(join(ctx.home, "cap", "registry.json"))).toBe(false);
    }
  });

  it("validates the checked-in manifest schema and rejects unknown fields", async () => {
    const source = join(ctx.home, "manifest.json");
    writeFileSync(source, JSON.stringify({ ...manifest, extra: true }));
    expect((await run("cap", "add", source))[0]).toBe(2);
    expect(existsSync(join(ctx.home, "cap", "registry.json"))).toBe(false);
    expect(readFileSync(source, "utf8")).toContain('"extra":true');
  });

  it("rejects a call before dispatch when auth env is missing, recording unknown usage", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    const [code, out, err] = await run("cap", "call", "fixture-provider", "example-task", "--input", input, "--task", "T-1", "--auth-env", "FIXTURE_API_KEY");
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("FIXTURE_API_KEY");
    const [usageCode, usageOut] = await run("cap", "usage");
    expect(usageCode).toBe(0);
    expect(JSON.parse(usageOut)).toMatchObject({
      provider_id: "fixture-provider", capability_id: "example-task", task_id: "T-1",
      outcome: "not_dispatched", credits: null, pages: null, model_tokens: null,
    });
  });

  it("does not read or send an AWS-named env value without exact caller confirmation", async () => {
    const bad = structuredClone(manifest);
    bad.provider.auth.env_var = "AWS_SECRET_ACCESS_KEY";
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(bad));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-canary-never-send";
    let calls = 0, out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: "{}" }; },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input], io)).toBe(2);
    expect(calls).toBe(0);
    expect(out + err).not.toContain("fixture-canary-never-send");
    expect(err).toContain("--auth-env AWS_SECRET_ACCESS_KEY");
    expect(JSON.parse((await run("cap", "usage"))[1])).toMatchObject({ outcome: "not_dispatched", credits: null });
  });

  it("adds a remote manifest through a zero-network fixture transport only at the declared origin", async () => {
    const source = "https://api.example.test/manifests/v1.json";
    const seen: Array<[string, string, string | null]> = [];
    let out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async (url, method, body, token) => {
        seen.push([url.toString(), method, token]);
        expect(body).toBeNull();
        return { status: 200, body: JSON.stringify(manifest) };
      },
    };
    expect(await main(["cap", "add", source], io), err).toBe(0);
    expect(out).toContain("added fixture-provider");
    expect(seen).toEqual([[source, "GET", null]]);
    expect((await run("cap", "list"))[1]).toContain("fixture-provider");
  });

  it("rejects credential-bearing remote source URLs without invoking the fixture transport", async () => {
    let calls = 0;
    const io: IO = {
      out: () => {}, err: () => {}, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(manifest) }; },
    };
    expect(await main(["cap", "add", "https://user:pass@api.example.test/manifest.json"], io)).toBe(2);
    expect(calls).toBe(0);
    expect(existsSync(join(ctx.home, "cap", "registry.json"))).toBe(false);
  });

  it("records explicit zero credits from a mocked failed POST without leaking its response body", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let out = "", err = "", calls = 0;
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async (url, method, body, token) => {
        calls++;
        expect([url.toString(), method, token]).toEqual(["https://api.example.test/v1/example-task", "POST", "fixture-token"]);
        expect(JSON.parse(body!)).toEqual({ input: {} });
        return { status: 503, body: JSON.stringify({ error: "fixture-body-must-not-print", usage: { credits: 0, pages: 0, model_tokens: 0 } }) };
      },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(1);
    expect(out + err).not.toContain("fixture-body-must-not-print");
    const row = JSON.parse((await run("cap", "usage"))[1]);
    expect(row).toMatchObject({ outcome: "http_error", http_status: 503, credits: 0, pages: 0, model_tokens: 0 });
  });

  it("accepts a mocked async 202 handle and explicit one-shot status GET, never polling", async () => {
    const asyncManifest = structuredClone(manifest);
    asyncManifest.capabilities[0].mode = "async";
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(asyncManifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    const seen: string[] = [];
    let out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async (url, method, body, token) => {
        expect(token).toBe("fixture-token");
        seen.push(`${method} ${url.pathname}`);
        return method === "POST"
          ? { status: 202, body: JSON.stringify({ job_id: "j1", status_path: "/v1/jobs/j1" }) }
          : { status: 200, body: JSON.stringify({ status: "running" }) };
      },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io), err).toBe(0);
    expect(JSON.parse(out)).toEqual({ job_id: "j1", status_path: "/v1/jobs/j1" });
    out = "";
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--status", "/v1/jobs/j1", "--auth-env", "FIXTURE_API_KEY"], io), err).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: "running" });
    expect(seen).toEqual(["POST /v1/example-task", "GET /v1/jobs/j1"]);
    expect((await run("cap", "call", "fixture-provider", "example-task", "--status", "https://evil.test/job"))[0]).toBe(2);
  });

  it("accepts a checked-in-schema sync envelope and records provider-reported usage", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => ({ status: 200, body: JSON.stringify(envelope) }),
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io), err).toBe(0);
    expect(JSON.parse(out)).toEqual(envelope);
    expect(JSON.parse((await run("cap", "usage"))[1])).toMatchObject({ outcome: "succeeded", credits: 2, pages: 1, model_tokens: 0 });
    expect(readFileSync(join(ctx.home, "cap", "usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("preserves partially reported usage as unknown rather than inventing zero", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    const partial = { ...envelope, usage: { credits: 2, model_tokens: 0 } };
    const io: IO = { out: () => {}, err: () => {}, stdin: () => "", capTransport: async () => ({ status: 200, body: JSON.stringify(partial) }) };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(0);
    expect(JSON.parse((await run("cap", "usage"))[1])).toMatchObject({ outcome: "usage_incomplete", credits: 2, pages: null, model_tokens: 0 });
  });

  it("rejects absent truncation siblings and responses exceeding manifest max_rows", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    const limitOne = structuredClone(manifest);
    limitOne.capabilities[0].max_rows = 1;
    writeFileSync(source, JSON.stringify(limitOne));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let response = { ...envelope } as Record<string, unknown>;
    let out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => ({ status: 200, body: JSON.stringify(response) }),
    };
    delete response.citations_truncated;
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    response = { ...envelope, citations: [...envelope.citations, ...envelope.citations], citations_truncated: true };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/envelope|max_rows/);
    const rows = (await run("cap", "usage"))[1].trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: "invalid_response", credits: null, pages: null, model_tokens: null });
    expect(rows[1]).toMatchObject({ outcome: "invalid_response", credits: null, pages: null, model_tokens: null });
  });

  it("validates a completed async result but never polls or guesses failed-job charges", async () => {
    const asyncManifest = structuredClone(manifest);
    asyncManifest.capabilities[0].mode = "async";
    const source = join(ctx.home, "manifest.json");
    writeFileSync(source, JSON.stringify(asyncManifest));
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let out = "", err = "", calls = 0;
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify({ status: "succeeded", result: envelope }) }; },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--status", "/v1/jobs/j1", "--auth-env", "FIXTURE_API_KEY"], io), err).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(out)).toEqual({ status: "succeeded", result: envelope });
    expect(JSON.parse((await run("cap", "usage"))[1])).toMatchObject({ outcome: "status_succeeded", credits: 2 });
  });

  it("refuses to dispatch if a durable usage intent cannot be written", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let calls = 0, err = "";
    const io: IO = {
      out: () => {}, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(envelope) }; },
    };
    Object.assign(io, { capAudit: () => { throw new CapError("fixture audit unavailable"); } });
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(0);
    expect(err).toContain("audit");
  });

  it("leaves a pending intent and warns against retry when completion append fails", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let calls = 0, writes = 0, out = "", err = "";
    const io: IO = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(envelope) }; },
    };
    Object.assign(io, { capAudit: (row: Parameters<typeof recordUsage>[0]) => { if (++writes === 2) throw new CapError("fixture disk full"); recordUsage(row); } });
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(1);
    expect(writes).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("audit completion failed");
    expect(err).toContain("do not retry");
    expect(JSON.parse((await run("cap", "usage"))[1])).toMatchObject({ outcome: "pending", credits: null, pages: null, model_tokens: null });
  });

  it("keeps the prior intent readable if a partial temporary completion write fails", () => {
    const intent = newUsageRow("fixture-provider", "example-task", null);
    intent.outcome = "pending";
    recordUsage(intent);
    const done = { ...intent, outcome: "succeeded", credits: 2 };
    let temporary = "";
    expect(() => Reflect.apply(recordUsage, undefined, [done, (path: string) => {
      temporary = path;
      writeFileSync(path, "{partial");
      throw new Error("fixture partial temporary write");
    }])).toThrow(/partial temporary write/);
    expect(existsSync(temporary)).toBe(false);
    expect(readUsage()).toEqual([intent]);
    expect(readFileSync(join(ctx.home, "cap", "usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("fails closed before dispatch when the bounded audit log is full", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    writeFileSync(join(ctx.home, "cap", "usage.jsonl"), "x".repeat(16 * 1024 * 1024));
    let calls = 0, err = "";
    const io: IO = {
      out: () => {}, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(envelope) }; },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(0);
    expect(err).toContain("audit intent failed");
  });

  it("reserves a completion event before dispatch when a valid audit log is near full", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    const intent = newUsageRow("fixture-provider", "example-task", null);
    intent.outcome = "pending";
    fillUsageLog(join(ctx.home, "cap", "usage.jsonl"), Buffer.byteLength(JSON.stringify(intent) + "\n") + USAGE_EVENT_LIMIT - 1);
    let calls = 0, err = "";
    const io: IO = {
      out: () => {}, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(envelope) }; },
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(0);
    expect(err).toContain("audit intent failed");
  });

  it("reserves completion capacity for every outstanding pending call", () => {
    const first = newUsageRow("fixture-provider", "example-task", null);
    const second = newUsageRow("fixture-provider", "example-task", null);
    first.outcome = second.outcome = "pending";
    const eventSize = (row: typeof first) => Buffer.byteLength(JSON.stringify(row) + "\n");
    fillUsageLog(join(ctx.home, "cap", "usage.jsonl"), eventSize(first) + eventSize(second) + 2 * USAGE_EVENT_LIMIT);
    recordUsage(first);
    recordUsage(second);
    const third = newUsageRow("fixture-provider", "example-task", null);
    third.outcome = "pending";
    expect(() => recordUsage(third)).toThrow(/16 MiB/);
    recordUsage({ ...first, outcome: "succeeded", credits: 1 });
    recordUsage({ ...second, outcome: "succeeded", credits: 1 });
    expect(readUsage().filter((row) => row.outcome === "succeeded")).toHaveLength(2);
  });

  it("rejects an oversized serialized audit event without truncating required metadata", () => {
    const row = newUsageRow("fixture-provider", "example-task", "task-" + "x".repeat(USAGE_EVENT_LIMIT));
    row.outcome = "pending";
    expect(() => recordUsage(row)).toThrow(/2 KiB/);
    expect(existsSync(join(ctx.home, "cap", "usage.jsonl"))).toBe(false);
  });

  it("fails closed if the intent rename cannot be made directory-durable", async () => {
    const source = join(ctx.home, "manifest.json");
    const input = join(ctx.home, "input.json");
    writeFileSync(source, JSON.stringify(manifest));
    writeFileSync(input, "{}");
    expect((await run("cap", "add", source))[0]).toBe(0);
    process.env.FIXTURE_API_KEY = "fixture-token";
    let calls = 0, err = "";
    const io: IO = {
      out: () => {}, err: (s) => { err += s; }, stdin: () => "",
      capTransport: async () => { calls++; return { status: 200, body: JSON.stringify(envelope) }; },
      capAudit: (row) => Reflect.apply(recordUsage, undefined, [row, undefined, () => { throw new Error("fixture directory fsync failure"); }]),
    };
    expect(await main(["cap", "call", "fixture-provider", "example-task", "--input", input, "--auth-env", "FIXTURE_API_KEY"], io)).toBe(2);
    expect(calls).toBe(0);
    expect(err).toContain("audit intent");
    expect(err).toContain("uncertain");
  });
});

describe("cap outbound address boundary", () => {
  it("rejects special-use IPv4 ranges and allows ordinary public addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "not-an-ip"]) {
      expect(isPublicIPv4(address), address).toBe(false);
    }
    expect(isPublicIPv4("1.1.1.1")).toBe(true);
  });
});
