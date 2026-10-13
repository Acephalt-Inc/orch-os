// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * `orch update check`: ask the package registry once which version it offers, and compare.
 *
 * This module only talks to the network. It reads no setting, keeps nothing between runs,
 * writes no file and starts nothing. One call makes at most one request and never follows
 * a redirect; one deadline covers the whole exchange.
 */
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

/** The one address the command asks. */
export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/orch-os/latest";
/** From before the connection is opened until the last byte of the body, in milliseconds. */
export const DEADLINE_MS = 800;
/** The most body bytes that are read, counted over every chunk. */
export const MAX_BODY_BYTES = 128 * 1024;
/** The longest version text that is accepted. */
export const MAX_VERSION_LENGTH = 64;

export type CheckResult =
  | { kind: "newer" | "current"; offered: string }
  | { kind: "unavailable"; reason: string };

// the grammar of semver.org 2.0.0
const ID = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${ID}(?:\\.${ID})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

interface Parsed {
  core: string[];
  pre: string[] | null;
}

function parseVersion(v: unknown): Parsed | null {
  if (typeof v !== "string" || v.length > MAX_VERSION_LENGTH) return null;
  const m = v.match(SEMVER);
  if (!m) return null;
  return { core: [m[1], m[2], m[3]], pre: m[4] === undefined ? null : m[4].split(".") };
}

/** Two numbers written in digits with no leading zero, of any size. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    // a numeric part is lower than one with letters
    const c = nx && ny ? compareDigits(x, y) : nx ? -1 : ny ? 1 : x === y ? 0 : x < y ? -1 : 1;
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Order two semantic versions: negative when `a` is lower, 0 when equal, positive when `a` is
 * higher; null when either is not a semantic version. A pre-release is lower than its release,
 * and build metadata does not order versions.
 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const c = compareDigits(x.core[i], y.core[i]);
    if (c !== 0) return c;
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  return comparePre(x.pre, y.pre);
}

const unavailable = (reason: string): CheckResult => ({ kind: "unavailable", reason });

/**
 * The addresses a request may go to: the registry address itself, or plain HTTP on 127.0.0.1
 * (the tests' local registry). Anything else is refused before a connection is opened.
 */
function target(address: string): URL | null {
  if (address === REGISTRY_LATEST_URL) return new URL(address);
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.username === "" && u.password === "" ? u : null;
}

/** Read the offered version out of a complete 200 body. */
function answer(running: string, body: Buffer): CheckResult {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    return unavailable("invalid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return unavailable("no version");
  const offered = (doc as Record<string, unknown>).version;
  if (typeof offered !== "string") return unavailable("no version");
  const order = compareVersions(offered, running);
  if (order === null) return unavailable("invalid version");
  return { kind: order > 0 ? "newer" : "current", offered };
}

/**
 * One GET to `address`. Resolves, never rejects: a newer or not-newer version when the reply is
 * a 200 `application/json` document with a semantic `version`, and `unavailable` with a short
 * fixed reason for everything else.
 */
export function checkLatest(running: string, address: string = REGISTRY_LATEST_URL): Promise<CheckResult> {
  return new Promise((resolve) => {
    const url = target(address);
    if (!url) return resolve(unavailable("invalid address"));
    const secure = url.protocol === "https:";
    // an agent of its own: one connection, not kept, and none of the shared default agent's routing
    const agent = secure ? new HttpsAgent({ keepAlive: false, maxSockets: 1 }) : new HttpAgent({ keepAlive: false, maxSockets: 1 });
    let done = false;
    let req: ReturnType<typeof httpRequest> | null = null;
    const finish = (result: CheckResult): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      req?.destroy();
      agent.destroy();
      resolve(result);
    };
    // the one deadline: started before the connection, cleared only by the result
    const deadline = setTimeout(() => finish(unavailable("timeout")), DEADLINE_MS);
    try {
      req = (secure ? httpsRequest : httpRequest)({
        protocol: url.protocol, hostname: url.hostname, port: url.port || (secure ? 443 : 80), path: url.pathname + url.search,
        method: "GET", headers: { accept: "application/json" }, agent,
      });
    } catch {
      return finish(unavailable("connection failed"));
    }
    req.on("error", () => finish(unavailable("connection failed")));
    req.on("response", (res) => {
      res.on("error", () => finish(unavailable("connection failed")));
      const status = res.statusCode ?? 0;
      // a redirect is an answer, not a new address: nothing is requested from `location`
      if (status >= 300 && status < 400) return finish(unavailable("redirect"));
      // only 200 carries a version; the body of any other status is not read
      if (status !== 200) return finish(unavailable(status >= 100 && status <= 599 ? `status ${status}` : "connection failed"));
      const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") return finish(unavailable("content type"));
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) return finish(unavailable("too large"));
        chunks.push(chunk);
      });
      // `end` only after a complete body; a reply cut short closes without it
      res.on("end", () => finish(res.complete ? answer(running, Buffer.concat(chunks)) : unavailable("connection failed")));
      res.on("close", () => finish(unavailable("connection failed")));
    });
    req.end();
  });
}

/** The one line the command prints. Registry text appears in it only as a validated version. */
export function updateLine(running: string, result: CheckResult): string {
  if (result.kind === "unavailable") return `update check: unavailable (${result.reason}); installed ${running}`;
  return result.kind === "newer"
    ? `update check: newer version available: installed ${running}, latest ${result.offered} (nothing was installed)`
    : `update check: no newer version: installed ${running}, latest ${result.offered}`;
}
