// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Arguments, help and the success line of the knowledge demo: the built entry as a child
// process for the two oracle rows, the command in-process for everything about arguments.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/knowledge/command.js";
import { createDemoTransport } from "../src/knowledge/demo.js";
import {
  BINDING, ENTRY, errorLine, EXPECTED, fixedClock, INVOICE_REQUEST, invoiceRef, ISO_TIME, node, okLine, QUERY, ROOT,
  Run, run,
} from "./fixtures/knowledge/harness.js";

const USAGE = errorLine("USAGE");
const WORDING = "Synthetic demo; no service connected.";

function runArgs(argv: string[]): Promise<Run> {
  return run(argv, createDemoTransport());
}

/** Exit 2, the fixed usage line, nothing on stdout and no transport call. */
function expectUsage(r: Run, label: string): void {
  expect(r.code, label).toBe(2);
  expect(r.err, label).toBe(USAGE);
  expect(r.out, label).toBe("");
  expect(r.calls, label).toEqual([]);
}

function argvBytes(argv: string[]): number {
  return Buffer.byteLength(argv.join("\0"), "utf8");
}

describe("knowledge command", () => {
  it("knowledge demo returns the exact current cited passage", async () => {
    for (const id of ["invoice-terms", "approval-threshold"]) {
      const oracle = EXPECTED[id];
      const before = Date.now();
      const child = await node([ENTRY, "query", "--connection", "demo", "--question-id", id]);
      const after = Date.now();
      expect([child.code, child.signal], id).toEqual([0, null]);
      expect(child.stderr, id).toBe("");
      expect(child.stdout.endsWith("\n"), id).toBe(true);
      expect(child.stdout.trimEnd().split("\n"), id).toHaveLength(1);
      const value = JSON.parse(child.stdout);
      expect(value, id).toEqual({
        status: "OK",
        mode: "synthetic",
        question_id: id,
        answer: oracle.answer,
        citation: {
          document_id: oracle.document_id,
          revision: oracle.revision,
          fragment: oracle.fragment,
          sha256: oracle.sha256,
          retrieved_at: expect.stringMatching(ISO_TIME),
          checked_at: expect.stringMatching(ISO_TIME),
        },
      });
      // The times are this run's own clock readings, in order.
      const retrieved = Date.parse(value.citation.retrieved_at);
      const checked = Date.parse(value.citation.checked_at);
      expect(retrieved, id).toBeGreaterThanOrEqual(before);
      expect(checked, id).toBeGreaterThanOrEqual(retrieved);
      expect(checked, id).toBeLessThanOrEqual(after);
      // The object equality above leaves no room for other text: the 30-day revision, the
      // revoked document and the other reader's document are absent.
    }
  });

  it("knowledge demo prints exactly the contract object at a fixed clock", async () => {
    // The fixed question texts: an identifier is expanded to its text and nothing else is sent.
    const texts: Record<string, string> = {
      "invoice-terms": "What are the synthetic invoice terms?",
      "approval-threshold": "What is the synthetic approval threshold?",
    };
    for (const id of ["invoice-terms", "approval-threshold"]) {
      const oracle = EXPECTED[id];
      const r = await runArgs(["query", "--connection", "demo", "--question-id", id]);
      expect(r.code, id).toBe(0);
      expect(r.out, id).toBe(okLine(id));
      expect(r.err, id).toBe("");
      // One lookup with the compiled binding, then one recheck of the citation it returned.
      expect(r.calls, id).toEqual([
        {
          name: "lookup",
          request: { schema_version: 1, ...BINDING, question_id: id, query: texts[id] },
          aborted: false,
        },
        {
          name: "revalidate",
          binding: BINDING,
          ref: {
            document_id: oracle.document_id, revision: oracle.revision, fragment: oracle.fragment,
            sha256: oracle.sha256,
          },
          aborted: false,
        },
      ]);
    }
    // The example line in the documentation is this output.
    const page = readFileSync(join(ROOT, "docs", "knowledge.md"), "utf8");
    expect(page).toContain("\n" + okLine("invoice-terms"));
  });

  it("knowledge refuses free text and unknown bindings before lookup", async () => {
    const bad = [
      ["query", "--connection", "demo", "--question", "secret"],
      ["query", "--connection", "demo", "--connection", "demo", "--question-id", "invoice-terms"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--question-id", "approval-threshold"],
      ["query", "--connection", "https://example.invalid", "--question-id", "invoice-terms"],
      ["query", "--connection", "demo"],
      ["query", "--question-id", "invoice-terms"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "extra"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "x".repeat(513)],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--principal", "other-reader"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--url", "https://example.invalid"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--document-id", "other-policy"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--endpoint", "https://example.invalid"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--upload", "notes.txt"],
      ["query", "--connection", "demo", "--question-id", "invoice-terms", "--attachment", "notes.txt"],
      ["query", "--connection", "demo", "--question-id", "What are the synthetic invoice terms?"],
      ["search", "--connection", "demo", "--question-id", "invoice-terms"],
      ["query"],
      [],
    ];
    for (const argv of bad) expectUsage(await runArgs(argv), JSON.stringify(argv));
  });

  it("knowledge accepts the equals spelling of both options", async () => {
    const r = await runArgs(["query", "--connection=demo", "--question-id=invoice-terms"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(okLine("invoice-terms"));
    expect(r.err).toBe("");
    expect(r.calls).toEqual([
      { name: "lookup", request: INVOICE_REQUEST, aborted: false },
      { name: "revalidate", binding: BINDING, ref: invoiceRef(), aborted: false },
    ]);
  });

  it("knowledge refuses a help flag in a value position", async () => {
    const bad = [
      ["query", "--connection", "-h", "--question-id", "invoice-terms"],
      ["query", "--connection", "demo", "--question-id", "--help"],
      ["query", "--connection=-h", "--question-id", "invoice-terms"],
    ];
    for (const argv of bad) expectUsage(await runArgs(argv), JSON.stringify(argv));
  });

  it("knowledge refuses a repeated option in the equals spelling", async () => {
    const bad = [
      ["query", "--connection=demo", "--connection=demo", "--question-id=invoice-terms"],
      ["query", "--connection=demo", "--question-id=invoice-terms", "--question-id=approval-threshold"],
      ["query", "--connection", "demo", "--connection=demo", "--question-id", "invoice-terms"],
    ];
    for (const argv of bad) expectUsage(await runArgs(argv), JSON.stringify(argv));
  });

  it("knowledge refuses a repeated option even next to a help flag", async () => {
    const argv = ["query", "--connection", "demo", "--connection", "demo", "--help"];
    expectUsage(await runArgs(argv), JSON.stringify(argv));
  });

  it("knowledge help flag ends the reading of the arguments", async () => {
    const top = (await runArgs(["--help"])).out;
    const sub = (await runArgs(["query", "--help"])).out;
    // In an option position a help flag prints the usage: what follows it is not examined, and
    // a stray word before it is not reported. The usage is the same as without them.
    const helped: [string[], string][] = [
      [["--help", "search", "--url", "https://example.invalid"], top],
      [["query", "--help", "--connection", "planted-connection-7f3a"], sub],
      [["query", "extra", "-h"], sub],
    ];
    for (const [argv, usage] of helped) {
      const r = await runArgs(argv);
      expect(r.code, JSON.stringify(argv)).toBe(0);
      expect(r.out, JSON.stringify(argv)).toBe(usage);
      expect(r.err, JSON.stringify(argv)).toBe("");
      expect(r.calls, JSON.stringify(argv)).toEqual([]);
    }
    expect(top).toContain(WORDING);
    expect(sub).toContain(WORDING);
    // An unknown command, an unknown option or an invalid value read before it is refused.
    const refused = [
      ["search", "--help"],
      ["query", "--url", "https://example.invalid", "--help"],
      ["query", "--connection", "planted-connection-7f3a", "--help"],
    ];
    for (const argv of refused) expectUsage(await runArgs(argv), JSON.stringify(argv));
  });

  it("knowledge accepts 512 bytes of arguments and refuses 513", async () => {
    // Only help flags, so the length is the one thing that differs between the two.
    const atCap = [...Array(72).fill("--help"), "-h", "-h", "-h"];
    const overCap = [...Array(73).fill("--help"), "-h"];
    expect([argvBytes(atCap), argvBytes(overCap)]).toEqual([512, 513]);
    const accepted = await runArgs(atCap);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain(WORDING);
    expect(accepted.err).toBe("");
    expectUsage(await runArgs(overCap), "513 bytes");
    // Bytes, not characters: 262 characters that take 514 bytes.
    const wide = ["--help", "-h", "é".repeat(252)];
    expect([wide.join("\0").length, argvBytes(wide)]).toEqual([262, 514]);
    expectUsage(await runArgs(wide), "514 bytes in 262 characters");
  });

  it("knowledge refuses another connection value without echoing it", async () => {
    const r = await runArgs(["query", "--connection", "planted-connection-7f3a", "--question-id", "invoice-terms"]);
    // The fixed bytes checked here hold nothing of the value.
    expectUsage(r, "other connection");
  });

  it("knowledge import and help have no operational side effects", async () => {
    for (const argv of [["--help"], ["-h"]]) {
      const r = await runArgs(argv);
      expect(r.code, argv.join(" ")).toBe(0);
      expect(r.err, argv.join(" ")).toBe("");
      expect(r.calls, argv.join(" ")).toEqual([]);
      expect(r.out, argv.join(" ")).toContain(WORDING);
    }
    // The top-level help lists one command and no other.
    const top = (await runArgs(["--help"])).out.split("\n");
    const commands = top.slice(top.indexOf("commands:") + 1).filter((line) => line.trim() !== "");
    expect(commands).toHaveLength(1);
    expect(commands[0].trim().split(/\s+/)[0]).toBe("query");
  });

  it("knowledge help of the query command states the demo wording and its two options", async () => {
    for (const argv of [["query", "--help"], ["query", "-h"], [...QUERY, "--help"]]) {
      const r = await runArgs(argv);
      expect(r.code, argv.join(" ")).toBe(0);
      expect(r.err, argv.join(" ")).toBe("");
      expect(r.calls, argv.join(" ")).toEqual([]);
      expect(r.out, argv.join(" ")).toContain(WORDING);
      const lines = r.out.split("\n");
      const options = lines.slice(lines.indexOf("options:") + 1).filter((line) => line.trim() !== "");
      const flags = options.map((line) => line.trim().split(/\s+/)[0]);
      expect(flags, argv.join(" ")).toEqual(["--connection", "--question-id"]);
    }
  });

  it("knowledge reports a failing output sink as itself, not as a usage error", async () => {
    const errWrites: string[] = [];
    const io = {
      out: () => {
        throw new Error("sink closed");
      },
      err: (s: string) => void errWrites.push(s),
    };
    const pending = main(QUERY, io, { transport: createDemoTransport(), now: fixedClock });
    await expect(pending).rejects.toThrow("sink closed");
    expect(errWrites).toEqual([]);
  });
});
