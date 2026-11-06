import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
const observer = resolve("tests/fixtures/vectors-local/observer.cjs");
const info = readFileSync(resolve("tests/fixtures/vectors-local/info.json"));
const embed = readFileSync(resolve("tests/fixtures/vectors-local/embed.json"));
const refused = { code: 1, out: "", err: "vectors connect-local: REFUSED\n" };
const success = { code: 0, out: "vectors connect-local: PROBE_OK dimension=384\n", err: "" };
const servers: ReturnType<typeof createServer>[] = [];

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing server address");
  return address.port;
}

async function installed(args: string[], port: number, noDial = false): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--require", observer, cli, "vectors", ...args], {
      env: {
        ...process.env,
        ORCH_VECTOR_EXPECT_PORT: String(port),
        ORCH_VECTOR_EXPECT_NO_DIAL: noDial ? "1" : "0",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
      },
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, out, err }));
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

describe("installed vectors preview socket boundary", () => {
  it("recorded_tei_probe_ok_installed_observed", async () => {
    const port = await serve((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/info" ? info : embed);
    });
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(success);
  });

  it("redirect_refused_without_follow", async () => {
    for (const path of ["/info", "/embed"]) {
      const port = await serve((request, response) => {
        if (request.url === path) {
          response.writeHead(302, { location: "http://example.com/secret" });
          response.end("secret");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(info);
        }
      });
      expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
    }
  });

  it("oversized_body_cut_off", async () => {
    const port = await serve((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/info") return response.end(info);
      response.write(Buffer.from("[[1,"));
      response.write(Buffer.alloc(256 * 1024, 32));
      response.end(Buffer.from("2]]"));
    });
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
  });

  it("one_deadline_across_both_requests", async () => {
    const port = await serve((request, response) => {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(request.url === "/info" ? info : embed);
      }, 3000);
    });
    const start = Date.now();
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
    expect(Date.now() - start).toBeLessThan(6000);
  });

  it("non_loopback_host_refused_before_connect", async () => {
    const port = await serve((_request, response) => response.end("unexpected"));
    expect(await installed(["connect-local", "--preview", "--url", `http://example.com:${port}`], port, true)).toEqual(refused);
  });

  it("wrong_content_type_refused", async () => {
    for (const path of ["/info", "/embed"]) {
      for (const duplicate of [false, true]) {
        const port = await serve((request, response) => {
          const type = request.url === path ? duplicate ? ["application/json", "application/json"] : "text/plain" : "application/json";
          response.writeHead(200, { "content-type": type });
          response.end(request.url === "/info" ? info : embed);
        });
        expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
      }
    }
  });

  it("early_close_and_misleading_length_refused", async () => {
    const port = await serve((request, response) => {
      if (request.url === "/info") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(info);
      }
      response.writeHead(200, { "content-type": "application/json", "content-length": embed.length + 100 });
      response.write(embed.subarray(0, 10));
      response.socket?.destroy();
    });
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
  });

  it("compressed_reply_refused", async () => {
    const port = await serve((request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(request.url === "/info" ? info : embed);
    });
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
  });

  it("oversized_header_refused", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "x-padding": "x".repeat(8192) });
      response.end(info);
    });
    expect(await installed(["connect-local", "--preview", "--url", `http://127.0.0.1:${port}`], port)).toEqual(refused);
  });
});
