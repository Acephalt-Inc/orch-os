// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch update check`: one request to the registry, one line, nothing else. Every test here talks
// to a real HTTP server on 127.0.0.1; none reaches a real network.
//
// Two ways of running the command:
//  - in this process, through main() with `runtime.updateUrl` (output, exit code, timing);
//  - in a child process, through tests/update-check-entry.mjs, which reports what the command did
//    as operations: file changes, process starts and connection attempts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helpOf } from "../src/args.js";
import { buildTree, main } from "../src/cli.js";
import { DIST_CLI, ROOT, tmp, useTmpHome, WINDOWS } from "./_helpers.js";
import { candidate, pack } from "./_pack.js";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const V: string = pkg.version;
const [MAJOR, MINOR, PATCH] = V.split(".").map(Number);
const ENTRY = join(ROOT, "tests", "update-check-entry.mjs");
const REGISTRY_URL = "https://registry.npmjs.org/orch-os/latest";
const CAP = 128 * 1024;
const newer = (latest: string) => `update check: newer version available: installed ${V}, latest ${latest} (nothing was installed)\n`;
const current = (latest: string) => `update check: no newer version: installed ${V}, latest ${latest}\n`;
const unavailable = (reason: string) => `update check: unavailable (${reason}); installed ${V}\n`;

// ---- the local registry -----------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface Fake {
  server: Server;
  origin: string;
  /** The address handed to the command: the registry path on this server. */
  url: string;
  requests: { method: string; url: string; accept: string }[];
  connections: number;
  handler: Handler;
}

/** The top-level keys of the registry's `latest` document, as measured; every value but `version` is made up. */
const DOCUMENT_KEYS = ["os", "bin", "bugs", "dist", "name", "type", "author", "engines", "gitHead", "license", "scripts", "_npmUser", "homepage",
  "keywords", "repository", "_npmVersion", "description", "directories", "maintainers", "_nodeVersion", "contributors", "dependencies",
  "publishConfig", "_hasShrinkwrap", "devDependencies", "_npmOperationalInternal", "_id", "version"];
const document = (version: unknown) => JSON.stringify(Object.fromEntries(DOCUMENT_KEYS.map((k) => [k, k === "version" ? version : "synthetic"])));
const reply = (status: number, body: string, type = "application/json", headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(body);
};
/** 200 with the measured document shape. */
const published = (version: unknown) => reply(200, document(version));
/** 404 as measured: `application/json`, and the body is a JSON string. */
const notFound = reply(404, JSON.stringify("synthetic not-found text"));

async function startFake(): Promise<Fake> {
  const fake: Fake = { server: createServer((req, res) => {
    fake.requests.push({ method: req.method ?? "", url: req.url ?? "", accept: String(req.headers.accept ?? "") });
    fake.handler(req, res);
  }), origin: "", url: "", requests: [], connections: 0, handler: notFound };
  fake.server.on("connection", () => fake.connections++);
  await new Promise<void>((resolve, reject) => {
    fake.server.once("error", reject);
    fake.server.listen(0, "127.0.0.1", resolve);
  });
  const address = fake.server.address();
  fake.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  fake.url = `${fake.origin}/orch-os/latest`;
  return fake;
}

async function stopFake(fake: Fake): Promise<void> {
  fake.server.closeAllConnections();
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
}

/** One fake registry per test. */
function useFake(): { fake: Fake } {
  const ctx = { fake: null as unknown as Fake };
  beforeEach(async () => {
    ctx.fake = await startFake();
  });
  afterEach(() => stopFake(ctx.fake));
  return ctx;
}

// ---- running the command ----------------------------------------------------------------------

type Out = { code: number; out: string; err: string; ms: number };

/** `orch update check` in this process, against `url`. */
async function check(url: string, argv = ["update", "check"]): Promise<Out> {
  let out = "";
  let err = "";
  const started = Date.now();
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s), stdin: () => "" }, { updateUrl: url } as Parameters<typeof main>[2]);
  return { code, out, err, ms: Date.now() - started };
}

type Op = { kind: "fs" | "process" | "connect"; op: string; target: string };
type Child = { status: number | null; stdout: string; stderr: string; ops: Op[]; ms: number };

/**
 * The command in a child process, under the operation observer. `address` is passed to main() as
 * `runtime.updateUrl`; "-" and "hold" pass none, so the command uses its own address, which the entry
 * never opens: "-" refuses the connection, "hold" leaves it unanswered.
 */
function child(home: string, address: string, opts: { argv?: string[]; env?: Record<string, string>; cli?: string; stdout?: number; nodeWarnings?: boolean } = {}): Promise<Child> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const c = spawn(process.execPath, [ENTRY, opts.cli ?? DIST_CLI, address, ...(opts.argv ?? [])], {
      env: { ...process.env, ORCH_HOME: home, ...opts.env }, stdio: ["ignore", opts.stdout ?? "pipe", "pipe", "pipe"],
    });
    const text = ["", "", "", ""];
    for (const fd of [1, 2, 3]) c.stdio[fd]?.on("data", (b: Buffer) => (text[fd] += b));
    const timer = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.once("error", (e) => reject(new Error(`entry child: spawn error: ${e}`)));
    c.once("close", (status, signal) => {
      clearTimeout(timer);
      try {
        // the child started, was not killed, ran main() to its end, and reported
        expect(signal, `entry child: signal\n${text[2]}`).toBeNull();
        expect(text[3].endsWith("\n"), `entry child: the report line is complete\n${text[2]}`).toBe(true);
        const report = JSON.parse(text[3]);
        expect(report.failure, "entry child: main() threw").toBeNull();
        expect(report.code, "entry child: main() returned the exit code").toBe(status);
        // Node's own warnings (lines in parentheses) are allowed only where a test sets Node options through the environment
        const stderr = opts.nodeWarnings ? text[2].split("\n").filter((l) => l && !l.startsWith("(")).join("\n") : text[2];
        resolve({ status, stdout: text[1], stderr, ops: report.ops, ms: Date.now() - started });
      } catch (e) {
        reject(e);
      }
    });
  });
}

const kindOf = (r: Child, kind: Op["kind"]) => r.ops.filter((o) => o.kind === kind);
const connects = (r: Child) => kindOf(r, "connect").map((o) => o.target);

// ---- what the command answers -----------------------------------------------------------------

describe("UpdateCheckAnswers", () => {
  const ctx = useFake();
  useTmpHome();

  it("newer_version_is_offered_on_stdout_with_both_versions_and_exit_0", async () => {
    const latest = `${MAJOR + 1}.0.0`;
    ctx.fake.handler = published(latest);
    const r = await check(ctx.fake.url);
    expect(r.out, "newer: stdout").toBe(newer(latest));
    expect(r.err, "newer: stderr").toBe("");
    expect(r.code, "newer: exit code").toBe(0);
  });

  it("the_installed_version_as_latest_claims_no_update_and_exits_0", async () => {
    for (const latest of [V, `${MAJOR}.${MINOR}.${PATCH}+build.7`, "0.0.1"]) {
      ctx.fake.handler = published(latest);
      const r = await check(ctx.fake.url);
      expect(r.out, `latest ${latest}: stdout`).toBe(current(latest));
      expect([r.code, r.err], `latest ${latest}: exit code and stderr`).toEqual([0, ""]);
    }
  });

  it("a_pre_release_of_the_installed_version_is_not_newer", async () => {
    const latest = `${V}-rc.1`;
    ctx.fake.handler = published(latest);
    const r = await check(ctx.fake.url);
    expect(r.out, "pre-release of the installed version: stdout").toBe(current(latest));
    expect(r.code, "pre-release of the installed version: exit code").toBe(0);
    // a pre-release of a later version is newer than the installed release
    const later = `${MAJOR}.${MINOR}.${PATCH + 1}-rc.1`;
    ctx.fake.handler = published(later);
    expect((await check(ctx.fake.url)).out, "pre-release of a later version: stdout").toBe(newer(later));
  });

  it("the_request_is_one_get_for_the_given_address", async () => {
    ctx.fake.handler = published(V);
    await check(ctx.fake.url);
    expect(ctx.fake.requests, "requests the registry received").toEqual([{ method: "GET", url: "/orch-os/latest", accept: "application/json" }]);
    expect(ctx.fake.connections, "connections the registry accepted").toBe(1);
  });

  it("a_not_found_reply_is_unavailable_and_its_body_is_never_read_as_a_version", async () => {
    const hostile = `${MAJOR + 7}.0.0`;
    for (const [what, handler] of [["a 404 whose body is a document", reply(404, document(hostile))], ["the measured 404", notFound]] as const) {
      ctx.fake.handler = handler;
      const r = await check(ctx.fake.url);
      expect(r.code, `${what}: exit code`).toBe(1);
      expect(r.out, `${what}: stdout`).toBe(unavailable("status 404"));
      expect(r.err, `${what}: stderr`).toBe("");
    }
  });

  it("any_status_other_than_200_is_unavailable", async () => {
    for (const status of [201, 204, 206, 400, 401, 403, 429, 500, 503]) {
      ctx.fake.handler = reply(status, status === 204 ? "" : document(`${MAJOR + 7}.0.0`));
      const r = await check(ctx.fake.url);
      expect([r.code, r.out, r.err], `status ${status}`).toEqual([1, unavailable(`status ${status}`), ""]);
    }
  });

  it("a_redirect_is_refused_and_its_target_is_never_requested", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      ctx.fake.requests.length = 0;
      ctx.fake.handler = (req, res) => {
        if (req.url === "/moved") return published(`${MAJOR + 7}.0.0`)(req, res);
        return reply(status, document(`${MAJOR + 7}.0.0`), "application/json", { location: `${ctx.fake.origin}/moved` })(req, res);
      };
      const r = await check(ctx.fake.url);
      expect(ctx.fake.requests.filter((q) => q.url === "/moved").length, `redirect ${status}: requests for the redirect target`).toBe(0);
      expect(r.code, `redirect ${status}: exit code`).toBe(1);
      expect(r.out, `redirect ${status}: stdout`).toBe(unavailable("redirect"));
      expect(ctx.fake.requests.length, `redirect ${status}: requests in all`).toBe(1);
    }
  });

  it("a_reply_that_is_not_application_json_is_unavailable", async () => {
    for (const type of ["text/html", "text/plain; charset=utf-8", "application/jsonx", "application/octet-stream", ""]) {
      ctx.fake.handler = (_req, res) => {
        res.writeHead(200, type ? { "content-type": type } : {});
        res.end(document(`${MAJOR + 7}.0.0`));
      };
      const r = await check(ctx.fake.url);
      expect([r.code, r.out, r.err], `content type '${type}'`).toEqual([1, unavailable("content type"), ""]);
    }
    // parameters after the type, and letter case, do not matter
    ctx.fake.handler = reply(200, document(V), "Application/JSON; charset=utf-8");
    expect((await check(ctx.fake.url)).out, "content type with a parameter").toBe(current(V));
  });

  it("a_body_that_is_not_json_or_has_no_usable_version_is_unavailable", async () => {
    const cases: [string, string, string][] = [
      ["a cut-off document", document(`${MAJOR + 7}.0.0`).slice(0, -1), "invalid JSON"],
      ["an empty body", "", "invalid JSON"],
      ["text", "not json", "invalid JSON"],
      ["a JSON string", JSON.stringify(`${MAJOR + 7}.0.0`), "no version"],
      ["a JSON array", JSON.stringify([{ version: `${MAJOR + 7}.0.0` }]), "no version"],
      ["null", "null", "no version"],
      ["a document without version", JSON.stringify({ name: "orch-os" }), "no version"],
      ["a numeric version", document(9), "no version"],
      ["a nested version", JSON.stringify({ version: { version: `${MAJOR + 7}.0.0` } }), "no version"],
      ["two parts", document("9.0"), "invalid version"],
      ["a v prefix", document("v9.0.0"), "invalid version"],
      ["a leading zero", document("09.0.0"), "invalid version"],
      ["a range", document(">=9.0.0"), "invalid version"],
      ["a tag name", document("latest"), "invalid version"],
      ["a trailing space", document("9.0.0 "), "invalid version"],
      ["a trailing line break", document("9.0.0\n"), "invalid version"],
      ["an empty pre-release part", document("9.0.0-a..b"), "invalid version"],
      ["a version of 65 characters", document(`9.0.0-${"a".repeat(59)}`), "invalid version"],
      ["a very long version", document(`9.0.0-${"a".repeat(4000)}`), "invalid version"],
    ];
    for (const [what, body, reason] of cases) {
      ctx.fake.handler = reply(200, body);
      const r = await check(ctx.fake.url);
      expect([r.code, r.out, r.err], what).toEqual([1, unavailable(reason), ""]);
    }
    // the longest version that is accepted: 64 characters
    const longest = `9.0.0-${"a".repeat(58)}`;
    ctx.fake.handler = published(longest);
    expect((await check(ctx.fake.url)).out, "a version of 64 characters").toBe(newer(longest));
  });

  it("a_body_over_128_kib_is_refused_however_it_is_split", async () => {
    // a valid document padded with spaces: the cap is the only reason to refuse it
    const padded = (bytes: number) => {
      const doc = document(`${MAJOR + 7}.0.0`);
      return doc + " ".repeat(bytes - Buffer.byteLength(doc));
    };
    const inChunks = (body: string, size: number): Handler => (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < body.length; i += size) res.write(body.slice(i, i + size));
      res.end();
    };
    for (const [what, size] of [["1 KiB chunks", 1024], ["one chunk", CAP + 1], ["7-byte steps past the cap", 7 * 1024 + 7]] as const) {
      ctx.fake.handler = inChunks(padded(CAP + 1), size);
      const r = await check(ctx.fake.url);
      expect(r.code, `${CAP + 1} bytes in ${what}: exit code`).toBe(1);
      expect(r.out, `${CAP + 1} bytes in ${what}: stdout`).toBe(unavailable("too large"));
    }
    ctx.fake.handler = inChunks(padded(CAP + 4096), 1024);
    expect((await check(ctx.fake.url)).out, "a larger body").toBe(unavailable("too large"));
    // exactly at the cap is read to its end
    ctx.fake.handler = inChunks(padded(CAP), 1024);
    expect((await check(ctx.fake.url)).out, `${CAP} bytes`).toBe(newer(`${MAJOR + 7}.0.0`));
  });

  it("a_reply_that_drips_one_byte_every_700_ms_ends_at_the_one_deadline", async () => {
    // every gap between bytes is shorter than the deadline, so only a deadline over the whole exchange can end it;
    // the body is a short valid document, so a reader that waits for all of it gets a version
    const body = JSON.stringify({ version: `${MAJOR + 7}.0.0` });
    let sent = 0;
    ctx.fake.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const timer = setInterval(() => {
        if (sent < body.length) res.write(body[sent++]);
        else res.end();
      }, 700);
      res.on("close", () => clearInterval(timer));
    };
    const r = await check(ctx.fake.url);
    expect(r.code, "dripping reply: exit code").toBe(1);
    expect(r.out, "dripping reply: stdout").toBe(unavailable("timeout"));
    expect(r.ms >= 700 && r.ms < 1500, `dripping reply: ended after ${r.ms} ms, expected within 700 to 1500 ms`).toBe(true);
    expect(sent, "dripping reply: bytes the registry had sent").toBeLessThan(3);
  });

  it("a_server_that_accepts_and_never_answers_ends_at_the_one_deadline", async () => {
    ctx.fake.handler = () => { /* no reply */ };
    const r = await check(ctx.fake.url);
    expect([r.code, r.out, r.err], "silent server").toEqual([1, unavailable("timeout"), ""]);
    expect(r.ms >= 700 && r.ms < 1500, `silent server: ended after ${r.ms} ms, expected within 700 to 1500 ms`).toBe(true);
  });

  it("a_refused_or_broken_connection_is_unavailable", async () => {
    ctx.fake.handler = (req) => req.socket.destroy();
    const cut = await check(ctx.fake.url);
    expect([cut.code, cut.out, cut.err], "connection closed without a reply").toEqual([1, unavailable("connection failed"), ""]);
    ctx.fake.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
      res.write(document(`${MAJOR + 7}.0.0`));
      res.socket?.destroy();
    };
    const short = await check(ctx.fake.url);
    expect([short.code, short.out], "reply cut off before its declared length").toEqual([1, unavailable("connection failed")]);
    await stopFake(ctx.fake);
    const refused = await check(ctx.fake.url);
    expect([refused.code, refused.out, refused.err], "nothing listening").toEqual([1, unavailable("connection failed"), ""]);
    ctx.fake = await startFake();
  });

  it("an_address_other_than_the_registry_or_this_machine_is_refused_without_a_request", async () => {
    // none of these names resolves anywhere: the reserved .invalid domain, and they are refused before any lookup
    for (const url of ["http://registry.invalid/orch-os/latest", "https://registry.invalid/orch-os/latest", `${REGISTRY_URL}?x=1`, "https://registry.npmjs.org.invalid/orch-os/latest",
      "http://user:secret@127.0.0.1:9/orch-os/latest", "ftp://127.0.0.1/orch-os/latest", "file:///orch-os/latest", "not an address", ""]) {
      const r = await check(url);
      expect([r.code, r.out, r.err], `address '${url}'`).toEqual([1, unavailable("invalid address"), ""]);
    }
    expect(ctx.fake.connections, "connections the registry accepted").toBe(0);
  });

  it("the_line_is_one_bounded_line_whatever_the_registry_sends", async () => {
    const handlers: Handler[] = [
      published(`${MAJOR + 1}.0.0`), published(V), published(`9.0.0-${"a".repeat(58)}`), published(`9.0.0-${"a".repeat(100_000)}`), published("9.0.0\nupdate available"),
      notFound, reply(302, "", "application/json", { location: "x".repeat(8000) }), reply(599, "x".repeat(5000)), reply(200, "x".repeat(5000)), reply(200, "x", "x".repeat(5000)),
    ];
    for (const [i, handler] of handlers.entries()) {
      ctx.fake.handler = handler;
      const r = await check(ctx.fake.url);
      expect(r.out.match(/\n/g)?.length, `reply ${i}: line breaks in stdout`).toBe(1);
      expect(r.out.endsWith("\n") && r.out.length <= 160, `reply ${i}: one line of at most 160 characters, got ${r.out.length}`).toBe(true);
      expect(/^update check: (newer version available|no newer version|unavailable \((timeout|redirect|status \d{3}|content type|too large|invalid JSON|no version|invalid version|connection failed)\))/.test(r.out),
        `reply ${i}: the line is one of the three forms: ${r.out}`).toBe(true);
      expect(r.err, `reply ${i}: stderr`).toBe("");
    }
  });

  it("an_output_sink_that_fails_after_a_prefix_gives_exit_1_and_a_later_run_is_unaffected", async () => {
    ctx.fake.handler = published(`${MAJOR + 1}.0.0`);
    let written = "";
    let calls = 0;
    let diagnostic = "";
    const code = await main(["update", "check"], {
      out: (s) => {
        calls++;
        written += s.slice(0, 9);
        throw new Error("sink closed after a prefix");
      },
      err: (s) => (diagnostic += s), stdin: () => "",
    }, { updateUrl: ctx.fake.url } as Parameters<typeof main>[2]);
    expect(code, "failing sink: exit code").toBe(1);
    expect([written, calls], "failing sink: what reached the sink, and how many writes were tried").toEqual(["update ch", 1]);
    expect(diagnostic, "failing sink: stderr").toBe("orch update check: output failed\n");
    // both sinks failing is still exit 1, not a crash
    const both = await main(["update", "check"], { out: () => { throw new Error("closed"); }, err: () => { throw new Error("closed"); }, stdin: () => "" },
      { updateUrl: ctx.fake.url } as Parameters<typeof main>[2]);
    expect(both, "both sinks failing: exit code").toBe(1);
    // nothing was kept from the failed runs: the next run asks again and answers in full
    const before = ctx.fake.requests.length;
    const again = await check(ctx.fake.url);
    expect([again.code, again.out, again.err], "the run after a failed one").toEqual([0, newer(`${MAJOR + 1}.0.0`), ""]);
    expect(ctx.fake.requests.length - before, "requests made by the run after a failed one").toBe(1);
  });

  it("update_needs_its_subcommand_and_check_takes_no_argument", async () => {
    ctx.fake.handler = published(V);
    for (const argv of [["update"], ["update", "check", "now"], ["update", "check", "--json"], ["update", "install"], ["update", "check", "--url", ctx.fake.url]]) {
      const r = await check(ctx.fake.url, argv);
      expect([r.code, r.out], `orch ${argv.join(" ")}: exit code and stdout`).toEqual([2, ""]);
    }
    expect(ctx.fake.requests.length, "requests made by usage errors").toBe(0);
  });
});

// ---- semantic versions ------------------------------------------------------------------------

describe("UpdateCheckVersions", () => {
  it("versions_are_ordered_as_semantic_versions_and_malformed_ones_are_refused", async () => {
    const { compareVersions } = await import("../src/update.js");
    const sign = (a: string, b: string) => {
      const c = compareVersions(a, b);
      return c === null ? null : Math.sign(c);
    };
    // the precedence chain of the semantic versioning specification, then releases
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
      "1.0.1", "1.0.9", "1.0.10", "1.1.0", "1.10.0", "2.0.0-0", "2.0.0", "9007199254740992.0.0", "9007199254740993.0.0", "10000000000000000000000.0.0"];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(sign(chain[i], chain[j]), `${chain[i]} against ${chain[j]}`).toBe(Math.sign(i - j));
      }
    }
    for (const [a, b] of [["1.0.0+a", "1.0.0+b"], ["1.0.0-rc.1+a", "1.0.0-rc.1"], ["1.0.0", "1.0.0+20260101"]]) {
      expect(sign(a, b), `${a} against ${b}: build metadata does not order versions`).toBe(0);
    }
    const malformed: unknown[] = ["", "1", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-01", "1.2.3-a..b", "1.2.3+", "1.2.3+a+b",
      " 1.2.3", "1.2.3 ", "1.2.3\n", ">=1.2.3", "latest", "1.2.x", "1.2.3-é", `1.2.3-${"a".repeat(59)}`, 123, null, undefined, {}, ["1.2.3"]];
    for (const bad of malformed) {
      expect(compareVersions(bad as string, "1.2.3"), `left ${JSON.stringify(bad)}`).toBeNull();
      expect(compareVersions("1.2.3", bad as string), `right ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("the_registry_address_and_the_two_limits_are_the_documented_ones", async () => {
    const update = await import("../src/update.js");
    expect([update.REGISTRY_LATEST_URL, update.DEADLINE_MS, update.MAX_BODY_BYTES]).toEqual([REGISTRY_URL, 800, CAP]);
  });
});

// ---- what the command does, observed as operations --------------------------------------------

describe("UpdateCheckOperations", () => {
  const ctx = useFake();
  const home = useTmpHome();

  it("update_check_makes_one_connection_changes_no_file_and_starts_no_process", async () => {
    const outcomes: [string, Handler, number, string][] = [
      ["a newer version", published(`${MAJOR + 1}.0.0`), 0, newer(`${MAJOR + 1}.0.0`)],
      ["no newer version", published(V), 0, current(V)],
      ["an unavailable answer", notFound, 1, unavailable("status 404")],
    ];
    for (const [what, handler, status, line] of outcomes) {
      ctx.fake.handler = handler;
      ctx.fake.connections = 0;
      const before = readdirSync(home.home, { recursive: true });
      const r = await child(home.home, ctx.fake.url);
      expect(r.stderr, `${what}: stderr`).toBe("");
      expect([r.status, r.stdout], `${what}: exit code and stdout`).toEqual([status, line]);
      expect(kindOf(r, "fs"), `${what}: file changes during update check`).toEqual([]);
      expect(kindOf(r, "process"), `${what}: processes started during update check`).toEqual([]);
      expect(connects(r), `${what}: connections opened during update check`).toEqual([ctx.fake.origin.slice("http://".length)]);
      expect(ctx.fake.connections, `${what}: connections the registry accepted`).toBe(1);
      // second check, by content: the home and everything under it is as it was (the operation list above is the proof; this cannot see a file written and removed)
      expect(readdirSync(home.home, { recursive: true }), `${what}: entries under the home afterwards`).toEqual(before);
    }
  });

  it("without_an_injected_address_the_one_connection_goes_to_the_npm_registry", async () => {
    const r = await child(home.home, "-");
    expect(r.stderr, "default address: stderr").toBe("");
    expect(connects(r), "default address: connections attempted").toEqual(["registry.npmjs.org:443"]);
    expect([r.status, r.stdout], "default address: exit code and stdout (the entry refuses the connection)").toEqual([1, unavailable("connection failed")]);
    expect(kindOf(r, "fs").concat(kindOf(r, "process")), "default address: file changes and process starts").toEqual([]);
    expect(ctx.fake.connections, "default address: connections the local registry accepted").toBe(0);
  });

  it("a_connection_that_is_never_answered_ends_at_the_one_deadline_and_the_process_exits", async () => {
    const r = await child(home.home, "hold");
    expect(connects(r), "unanswered connection: connections attempted").toEqual(["registry.npmjs.org:443"]);
    expect([r.status, r.stdout, r.stderr], "unanswered connection: exit code and output").toEqual([1, unavailable("timeout"), ""]);
    // the whole child process, from start to exit: not before the deadline, and not held open after it
    expect(r.ms >= 800 && r.ms < 10_000, `unanswered connection: the process ran ${r.ms} ms, expected 800 to 10000 ms`).toBe(true);
  });

  it("update_check_does_not_load_the_config_file", async () => {
    mkdirSync(home.home, { recursive: true });
    writeFileSync(join(home.home, "config.toml"), "this is = not [valid toml\n");
    const config = await child(home.home, "-", { argv: ["config"] });
    expect(config.status, "orch config with a malformed config.toml: exit code").toBe(2);
    ctx.fake.handler = published(V);
    const r = await child(home.home, ctx.fake.url);
    expect([r.status, r.stdout, r.stderr], "update check with a malformed config.toml").toEqual([0, current(V), ""]);
  });

  it("no_environment_variable_redirects_or_disables_the_request", async () => {
    const decoy = await startFake();
    decoy.handler = published(`${MAJOR + 9}.0.0`);
    let tunnels = 0;
    decoy.server.on("connect", (_req, socket) => {
      tunnels++;
      socket.destroy();
    });
    try {
      const env: Record<string, string> = {};
      for (const name of ["ORCH_UPDATE_URL", "ORCH_UPDATE_CHECK_URL", "ORCH_UPDATE_TEST_URL", "ORCH_REGISTRY", "ORCH_REGISTRY_URL", "UPDATE_URL",
        "npm_config_registry", "NPM_CONFIG_REGISTRY"]) env[name] = decoy.url;
      // a proxy is named by its origin
      for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) env[name] = decoy.origin;
      for (const name of ["ORCH_UPDATE_CHECK", "ORCH_NO_UPDATE_CHECK", "ORCH_UPDATE", "NO_UPDATE_NOTIFIER", "CI"]) env[name] = "0";
      Object.assign(env, { NODE_USE_ENV_PROXY: "1", NO_PROXY: "", no_proxy: "", NODE_ENV: "test" });
      // with the test address: the request still goes there, once
      ctx.fake.handler = published(`${MAJOR + 1}.0.0`);
      const injected = await child(home.home, ctx.fake.url, { env, nodeWarnings: true });
      expect(decoy.connections, "connections the address named by the environment received").toBe(0);
      expect(connects(injected), "connections attempted with the environment set").toEqual([ctx.fake.origin.slice("http://".length)]);
      expect([injected.status, injected.stdout, injected.stderr], "exit code and output with the environment set").toEqual([0, newer(`${MAJOR + 1}.0.0`), ""]);
      // with no test address: the command's own address, whatever the environment says
      const own = await child(home.home, "-", { env, nodeWarnings: true });
      expect(connects(own), "connections attempted by the command's own address with the environment set").toEqual(["registry.npmjs.org:443"]);
      expect([decoy.connections, tunnels, decoy.requests.length], "connections, tunnels and requests the address named by the environment received").toEqual([0, 0, 0]);
      expect(own.status, "exit code (the entry refuses the connection)").toBe(1);
    } finally {
      await stopFake(decoy);
    }
  });

  it("no_other_command_contacts_the_registry", async () => {
    mkdirSync(home.home, { recursive: true });
    const init = await child(home.home, "-", { argv: ["init", "--no-profile", "--no-handbook"] });
    expect(init.status, `init exit code\n${init.stdout}${init.stderr}`).toBe(0);
    for (const argv of [["--version"], ["--help"], ["update", "--help"], ["update", "check", "--help"], ["update"], ["config"], ["agents"], ["doctor"], ["lease", "status"], ["mailbox", "read"], ["load", "--read"]]) {
      const r = await child(home.home, "-", { argv });
      expect(connects(r), `connections attempted by orch ${argv.join(" ")}`).toEqual([]);
      expect(kindOf(r, "process"), `processes started by orch ${argv.join(" ")}`).toEqual([]);
    }
    expect(connects(init), "connections attempted by orch init").toEqual([]);
    expect(ctx.fake.connections, "connections the local registry accepted").toBe(0);
  });

  it("a_real_process_whose_stdout_cannot_be_written_exits_nonzero", async () => {
    ctx.fake.handler = published(`${MAJOR + 1}.0.0`);
    mkdirSync(home.home, { recursive: true });
    const file = join(home.home, "read-only-stdout.txt");
    writeFileSync(file, "");
    const fd = openSync(file, "r");
    // main() returns before Node reports the failed write, so the helper's checks on the report are not used here
    const run = (stdout: number | "pipe") => new Promise<[number | null, NodeJS.Signals | null, string]>((resolve, reject) => {
      const c = spawn(process.execPath, [ENTRY, DIST_CLI, ctx.fake.url], { env: { ...process.env, ORCH_HOME: home.home }, stdio: ["ignore", stdout, "pipe", "ignore"] });
      let stderr = "";
      c.stderr!.on("data", (b: Buffer) => (stderr += b));
      // a reader that goes away before the line is written
      c.stdout?.destroy();
      c.once("error", reject);
      c.once("close", (code, signal) => resolve([code, signal, stderr]));
    });
    try {
      // the reply waits, so the reader of the pipe is gone before the line is written
      ctx.fake.handler = (req, res) => void setTimeout(() => published(`${MAJOR + 1}.0.0`)(req, res), 200);
      for (const [what, stdout, error] of [["stdout opened for reading only", fd, "EBADF"], ["stdout pipe closed by its reader", "pipe", "EPIPE"]] as const) {
        ctx.fake.requests.length = 0;
        const [status, signal, stderr] = await run(stdout);
        expect(ctx.fake.requests.length, `${what}: the request was made`).toBe(1);
        // the error names are the ones measured on macOS; on Windows only the exit code is checked
        if (!WINDOWS) expect(stderr, `${what}: the write error on stderr`).toContain(error);
        expect(signal, `${what}: signal`).toBeNull();
        expect(status === 0 || status === null, `${what}: exit code ${status} is not a failure`).toBe(false);
      }
      expect(readFileSync(file, "utf8"), "stdout opened for reading only: file content").toBe("");
    } finally {
      closeSync(fd);
    }
  });
});

// ---- the package ------------------------------------------------------------------------------

describe("UpdateCheckPackage", () => {
  const ctx = useFake();
  const home = useTmpHome();
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("the_packed_cli_runs_update_check_and_has_no_automatic_check_cache_lock_switch_or_install_code", async () => {
    const copy = candidate(dirs);
    const tarball = pack(copy);
    const files = copy.run("tar", ["-tzf", tarball]).trim().split("\n");
    expect(files, "the tarball has the update module").toContain("package/dist/update.js");
    expect(files.filter((f) => /update|cache|lock|notif/i.test(f) && !/^package\/dist\/(update|lock)\.js$/.test(f)), "other update, cache, lock or notice files in the tarball").toEqual([]);
    const out = tmp("orch-uc-pack-");
    dirs.push(out);
    copy.run("tar", ["-xzf", tarball, "-C", out]);
    const dist = join(out, "package", "dist");
    const update = readFileSync(join(dist, "update.js"), "utf8");
    const cli = readFileSync(join(dist, "cli.js"), "utf8");
    const walkJs = (dir: string, prefix = ""): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walkJs(join(dir, entry.name), name) : entry.isFile() && entry.name.endsWith(".js") ? [name] : [];
    });
    const compiled = walkJs(dist);
    expect(compiled, "compiled JavaScript files walked below dist").toContain("cli.js");
    expect(compiled.some((file) => file.includes("/")), "compiled JavaScript files walked below dist include a nested file").toBe(true);
    // no other module of the package can reach a network
    for (const file of compiled.filter((f) => f !== "update.js")) {
      expect(readFileSync(join(dist, file), "utf8").match(/node:(?:http2?|https|net|tls|dgram|dns)\b|["'](?:http2?|https|net|tls|dgram|dns)["']|\bfetch\s*\(|WebSocket|XMLHttpRequest|undici/g),
        `network modules or calls in dist/${file}`).toBeNull();
    }
    // the update module: network only. No file system, no process, no environment, no other module of this package.
    expect([...update.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), "modules dist/update.js imports").toEqual(["node:http", "node:https"]);
    expect(update.match(/\b(?:require|import)\s*\(/g), "dynamic loading in dist/update.js").toBeNull();
    expect(update.match(/\bprocess\b|globalThis|\benv\b|child_process|\bspawn|\bexec|\bfetch\b|writeFile|appendFile|openSync|mkdir|rename|unlink|\.lock|cache|setInterval|unref|\bnpm\b|\bnpx\b|--global|upgrade/gi),
      "environment, process, file, cache, lock, background or package-manager words in dist/update.js").toBeNull();
    // the CLI: the check is called from one place, the update check handler, and that handler is reachable from one command
    expect(cli.match(/\bcheckLatest\(/g)?.length, "calls of checkLatest in dist/cli.js").toBe(1);
    expect(cli.match(/cmdUpdateCheck/g)?.length, "mentions of the handler in dist/cli.js (its definition and one command)").toBe(2);
    expect(cli.match(/_updateUrl/g)?.length, "uses of the injected address in dist/cli.js (set from runtime, read by the handler)").toBe(2);
    expect(cli.match(/args\._updateUrl = runtime\.updateUrl;/g)?.length, "the injected address comes from the runtime parameter of main()").toBe(1);
    const handler = /^const cmdUpdateCheck = async \(a, io\) => \{\n([\s\S]*?)\n\};$/m.exec(cli)?.[1] ?? "";
    expect(handler, "the handler in dist/cli.js").toContain("await checkLatest(VERSION, a._updateUrl)");
    expect(handler.match(/\bprocess\b|\benv\b|\bC\.|Sync\(|spawn|setTimeout|setInterval/g), "environment, config, file, process or timer use in the handler").toBeNull();
    for (const file of compiled) {
      const text = readFileSync(join(dist, file), "utf8");
      expect(text.match(/ORCH_UPDATE|UPDATE_CHECK|update-check\.|update_check|npm_config_registry|registry\.npmjs\.org/gi) ?? [], `update switches, state files or registry addresses in dist/${file}`)
        .toEqual(file === "update.js" ? ["registry.npmjs.org"] : []);
    }
    // and it runs from the packed files
    ctx.fake.handler = published(`${MAJOR + 1}.0.0`);
    const r = await child(home.home, ctx.fake.url, { cli: join(dist, "cli.js") });
    expect([r.status, r.stdout, r.stderr], "packed cli: update check").toEqual([0, newer(`${MAJOR + 1}.0.0`), ""]);
    expect(r.ops.filter((o) => o.kind !== "connect"), "packed cli: file changes and process starts").toEqual([]);
  });
});

// ---- public text ------------------------------------------------------------------------------

describe("UpdateCheckPublicText", () => {
  it("public_text_manifest_matches_the_docs_and_the_help", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "part2-public-text.json"), "utf8"));
    expect(typeof manifest.owner_approved, "owner_approved is recorded").toBe("boolean");
    const tree = buildTree();
    const update = tree.sub!.find((c) => c.name === "update")!;
    const sources: Record<string, string> = {
      "orch --help": helpOf(tree, ["orch"]),
      "orch update --help": helpOf(update, ["orch", "update"]),
      "orch update check --help": helpOf(update.sub![0], ["orch", "update", "check"]),
    };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(manifest.blocks.length, "blocks in the manifest").toBeGreaterThan(0);
    for (const b of manifest.blocks) {
      expect(sha(b.text), `${b.id}: sha256 of the recorded text`).toBe(b.sha256);
      const where = b.command ? sources[b.command] : readFileSync(join(ROOT, b.file), "utf8");
      expect(where.split(b.text).length - 1, `${b.id}: the recorded text appears once in ${b.command ?? b.file}`).toBe(1);
    }
  });

  it("the_command_reference_names_the_lines_and_limits_the_command_has", async () => {
    const docs = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
    const start = docs.indexOf("## orch update check\n");
    expect(start >= 0, "docs/commands.md has an orch update check section").toBe(true);
    const section = docs.slice(start, docs.indexOf("\n## ", start + 1));
    for (const line of [newer("Y"), current("Y"), unavailable("REASON")]) {
      expect(section, "docs/commands.md: result line").toContain(`\`${line.trim().split(V).join("X")}\``);
    }
    expect(section, "docs/commands.md: the address").toContain(`\`GET ${REGISTRY_URL}\``);
    expect(section, "docs/commands.md: the deadline").toContain("one deadline of 800 ms");
    expect(section, "docs/commands.md: the body cap").toContain("over 128 KiB is refused");
    const reasons = ["timeout", "redirect", "status N", "content type", "too large", "invalid JSON", "no version", "invalid version", "connection failed"];
    expect(/`REASON` is one of ([^.]*)\./.exec(section)?.[1].match(/`[^`]+`/g), "docs/commands.md: the reasons").toEqual(reasons.map((r) => `\`${r}\``));
  });
});
