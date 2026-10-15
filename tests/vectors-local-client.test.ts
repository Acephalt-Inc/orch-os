import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runVectorsCommand } from "../src/vectors-local/command.js";
import type { Transport, WireResponse } from "../src/vectors-local/client.js";

const fixture = (name: string) => readFileSync(resolve("tests/fixtures/vectors-local", name));
const info = fixture("info.json");
const embed = fixture("embed.json");
const rawHeaders = (name: string): string[] => Buffer.from(fixture(name + ".b64").toString("ascii"), "base64")
  .toString("utf8").split("\r\n").slice(1)
  .filter((line) => line.includes(":"))
  .flatMap((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
  });
const success = (n: number) => ({ code: 0, out: `vectors connect-local: PROBE_OK dimension=${n}\n`, err: "" });
const refused = { code: 1, out: "", err: "vectors connect-local: REFUSED\n" };
const usage = { code: 2, out: "", err: "vectors connect-local: USAGE\n" };
type Reply = { status?: number; headers?: string[]; body?: Uint8Array; chunks?: Uint8Array[]; error?: Error };
const headers = ["content-type", "application/json"];
const base: Reply[] = [
  { body: info, headers: rawHeaders("info.headers") },
  { body: embed, headers: rawHeaders("embed.headers") },
];

async function run(replies: Reply[] = base, url = "http://127.0.0.1:18080") {
  const calls: Array<{ path: string; method: string; body?: string; host: string; port: number }> = [];
  const transport: Transport = async (request) => {
    calls.push({ path: request.path, method: request.method, body: request.body, host: request.host, port: request.port });
    const reply = replies[calls.length - 1];
    if (!reply || reply.error) throw reply?.error ?? new Error("unexpected request");
    const wire: WireResponse = {
      status: reply.status ?? 200,
      rawHeaders: reply.headers ?? headers,
      chunks: (async function* () { for (const chunk of reply.chunks ?? [reply.body ?? Buffer.alloc(0)]) yield chunk; })(),
      abort: () => undefined,
    };
    return wire;
  };
  let out = "";
  let err = "";
  const code = await runVectorsCommand(["connect-local", "--preview", "--url", url], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  }, transport);
  return { result: { code, out, err }, calls };
}

describe("plain TEI preview through trusted transport", () => {
  it("recorded_tei_probe_ok", async () => {
    const { result, calls } = await run();
    expect(result).toEqual(success(384));
    expect(calls).toEqual([
      { path: "/info", method: "GET", body: undefined, host: "127.0.0.1", port: 18080 },
      { path: "/embed", method: "POST", body: '{"inputs":"orch probe","truncate":false}', host: "127.0.0.1", port: 18080 },
    ]);
  });

  it("observed_dimension_bounds", async () => {
    for (const n of [2, 1536, 1537]) {
      const body = Buffer.from(JSON.stringify([Array.from({ length: n }, (_, i) => i === 0 ? 1 : 0)]));
      expect((await run([{ body: info }, { body }])).result).toEqual(n <= 1536 ? success(n) : refused);
    }
  });

  it("info_shape_and_limit_refused", async () => {
    const doc = JSON.parse(info.toString("utf8"));
    for (const body of [
      Buffer.from(JSON.stringify({ ...doc, version: "1.9.5" })),
      Buffer.from(JSON.stringify({ ...doc, version: undefined })),
      Buffer.from(JSON.stringify({ ...doc, max_input_length: undefined })),
      Buffer.from(JSON.stringify({ ...doc, auto_truncate: "true" })),
      Buffer.from(JSON.stringify({ ...doc, model_id: "" })),
      Buffer.from(JSON.stringify({ ...doc, served_model_name: "x".repeat(257) })),
      Buffer.from(JSON.stringify({ ...doc, model_type: { embedding: {} } })),
      Buffer.from(info.toString("utf8").replace('"version":"1.9.4"', '"version":"1.9.4","vers\\u0069on":"1.9.4"')),
      Buffer.from([0xff]),
      Buffer.alloc(8193, 32),
    ]) {
      const { result, calls } = await run([{ body }, { body: embed }]);
      expect(result).toEqual(refused);
      expect(calls).toHaveLength(1);
    }
  });

  it("explicit_no_truncation_request", async () => {
    const accepted = await run();
    expect(accepted.result).toEqual(success(384));
    expect(accepted.calls[1].body).toBe('{"inputs":"orch probe","truncate":false}');
    expect((await run([{ body: info }, { status: 422, body: Buffer.from("secret error") }])).result).toEqual(refused);
  });

  it("embed_shape_and_limit_refused", async () => {
    for (const n of [383, 385]) {
      const body = Buffer.from(JSON.stringify([Array.from({ length: n }, (_, i) => i === 0 ? 1 : 0)]));
      expect((await run([{ body: info }, { body }])).result).toEqual(success(n));
    }
    for (const body of [
      "[[]]", "[[0,0]]", "[[1,NaN]]", "[[1e999]]", "[[1],[2]]", "[[1]] true", "[[1,]]",
    ]) expect((await run([{ body: info }, { body: Buffer.from(body) }])).result).toEqual(refused);
    expect((await run([{ body: info }, { body: Buffer.from([0xff]) }])).result).toEqual(refused);
    expect((await run([{ body: info }, { chunks: [Buffer.from("[[1"), Buffer.alloc(256 * 1024, 32), Buffer.from("]] ")] }])).result)
      .toEqual(refused);
    let calls = 0;
    let aborted = false;
    const transport: Transport = async () => {
      calls++;
      return calls === 1
        ? { status: 200, rawHeaders: headers, chunks: (async function* () { yield info; })(), abort: () => undefined }
        : {
          status: 200,
          rawHeaders: headers,
          chunks: (async function* () { yield Buffer.from("[[1"); yield Buffer.alloc(256 * 1024, 32); yield Buffer.from("]] "); })(),
          abort: () => { aborted = true; },
        };
    };
    let out = "";
    let err = "";
    const code = await runVectorsCommand(["connect-local", "--preview", "--url", "http://127.0.0.1:1"], {
      out: (s) => { out += s; }, err: (s) => { err += s; },
    }, transport);
    expect({ code, out, err }).toEqual(refused);
    expect(aborted).toBe(true);
  });

  it("command_grammar_usage", async () => {
    const transport: Transport = async () => { throw new Error("called"); };
    for (const args of [
      [], ["connect-local"], ["--preview", "connect-local", "--url", "http://127.0.0.1:1"],
      ["connect-local", "--url", "http://127.0.0.1:1", "--preview"],
      ["connect-local", "--preview", "--preview", "--url", "http://127.0.0.1:1"],
      ["connect-local", "--preview", "--url", "http://127.0.0.1:1", "--apply"],
      ["connect-local", "--preview", "--url", "http://127.0.0.1:1", "extra"],
    ]) {
      let out = "";
      let err = "";
      const code = await runVectorsCommand(args, { out: (s) => { out += s; }, err: (s) => { err += s; } }, transport);
      expect({ code, out, err }).toEqual(usage);
    }
  });

  it("url_refused_before_transport", async () => {
    for (const url of [
      "http://example.com:80", "http://127.1:80", "http://localhost:80", "http://user@127.0.0.1:80",
      "http://127.0.0.1:80/x", "http://127.0.0.1:80?x", "http://127.0.0.1:80#x",
      "http://127.0.0.1:80\n", "http://127.0.0.1:0", "http://127.0.0.1:65536",
      "http://127.0.0.1:080", "http://127.0.0.1:80%2f", "http://[::1%25lo0]:80", "http://::1:80",
      "http://127.0.0.1:80\u00a0", "http://127.0.0.1:\u0661",
    ]) {
      const { result, calls } = await run(base, url);
      expect(result).toEqual(refused);
      expect(calls).toHaveLength(0);
    }
    expect((await run(base, "http://[::1]:80/")).result).toEqual(success(384));
  });

  it("untrusted_error_not_echoed", async () => {
    const marker = "TOKEN_secret\u0001\u2028";
    const errors = [
      [{ status: 500, body: Buffer.from(marker) }],
      [{ error: new Error(marker) }],
      [{ body: info, headers: ["content-type", "text/plain"] }],
      [{ body: info, headers: ["content-type", "application/json", "content-type", "application/json"] }],
      [{ body: info, headers: ["content-type", "application/json", "content-encoding", "gzip"] }],
      [{ body: info, headers: ["content-type", "application/json", "content-length", "1"] }],
      [{ body: info, headers: ["content-type", "application/json", "content-length", "455", "content-length", "455"] }],
      [{ body: info, headers: ["content-type", "application/json", "content-length", "8193"] }],
    ];
    for (const replies of errors) {
      const { result, calls } = await run(replies);
      expect(result).toEqual(refused);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});
