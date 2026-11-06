import { request as httpRequest } from "node:http";
import { observedDimension, validateInfo } from "./protocol.js";

export interface WireResponse {
  status: number;
  rawHeaders: string[];
  chunks: AsyncIterable<Uint8Array>;
  abort(): void;
}

export interface RequestSpec {
  host: string;
  port: number;
  path: string;
  method: "GET" | "POST";
  body?: string;
  signal: AbortSignal;
}

export type Transport = (request: RequestSpec) => Promise<WireResponse>;

const MAX_INFO = 8 * 1024;
const MAX_EMBED = 256 * 1024;
const BODY = '{"inputs":"orch probe","truncate":false}';

export function parseOrigin(value: string): { host: string; port: number } | null {
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([^/]+)\/?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const rawPort = match[2];
  if (rawPort.length > 5 || (rawPort.length > 1 && rawPort[0] === "0")) return null;
  for (const character of rawPort) {
    if (!/^\p{ASCII}$/u.test(character) || !/^\p{Decimal_Number}$/u.test(character)) return null;
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] === "[::1]" ? "::1" : "127.0.0.1", port };
}

export const stockTransport: Transport = (spec) => new Promise((resolve, reject) => {
  if (spec.signal.aborted) return reject(new Error("refused"));
  const request = httpRequest({
    hostname: spec.host,
    port: spec.port,
    path: spec.path,
    method: spec.method,
    agent: false,
    maxHeaderSize: 8 * 1024,
    headers: spec.method === "POST"
      ? { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(spec.body ?? "") }
      : { accept: "application/json" },
  });
  const abort = () => request.destroy(new Error("refused"));
  spec.signal.addEventListener("abort", abort, { once: true });
  request.on("error", reject);
  request.on("response", (response) => {
    response.on("error", () => undefined);
    resolve({
      status: response.statusCode ?? 0,
      rawHeaders: response.rawHeaders,
      chunks: (async function* () {
        try {
          for await (const chunk of response) yield chunk as Buffer;
          if (!response.complete) throw new Error("refused");
        } finally {
          spec.signal.removeEventListener("abort", abort);
        }
      })(),
      abort,
    });
  });
  request.end(spec.body);
});

function header(raw: string[], name: string): string[] {
  const values: string[] = [];
  if (raw.length % 2 !== 0) throw new Error("refused");
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index].toLowerCase() === name) values.push(raw[index + 1]);
  }
  return values;
}

async function read(response: WireResponse, max: number): Promise<Uint8Array> {
  try {
    if (response.status !== 200) throw new Error("refused");
    const types = header(response.rawHeaders, "content-type");
    if (types.length !== 1 || types[0] !== "application/json") throw new Error("refused");
    if (header(response.rawHeaders, "content-encoding").length !== 0) throw new Error("refused");
    const lengths = header(response.rawHeaders, "content-length");
    if (lengths.length > 1) throw new Error("refused");
    if (lengths.length === 1) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(lengths[0]) || Number(lengths[0]) > max) throw new Error("refused");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.chunks) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > max - total) throw new Error("refused");
      total += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }
    if (lengths.length === 1 && total !== Number(lengths[0])) throw new Error("refused");
    return Buffer.concat(chunks, total);
  } catch (error) {
    response.abort();
    throw error;
  }
}

export async function probe(origin: { host: string; port: number }, transport: Transport): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const info = await transport({ ...origin, path: "/info", method: "GET", signal: controller.signal });
    validateInfo(await read(info, MAX_INFO));
    if (controller.signal.aborted) throw new Error("refused");
    const embed = await transport({ ...origin, path: "/embed", method: "POST", body: BODY, signal: controller.signal });
    const bytes = await read(embed, MAX_EMBED);
    if (controller.signal.aborted) throw new Error("refused");
    return observedDimension(bytes);
  } finally {
    clearTimeout(timer);
  }
}
