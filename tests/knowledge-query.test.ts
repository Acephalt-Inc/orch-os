// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The query sequence of the knowledge demo, run in-process through the command: every case
// asserts the exit code, the exact error or success bytes and the transport calls made.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoStore, createDemoTransport, DemoStore } from "../src/knowledge/demo.js";
import { Refusal, serializeOutput, Transport } from "../src/knowledge/schema.js";
import {
  BINDING, canary, dec, echoTransport, enc, errorLine, EXPECTED, FIXED_TIME, fixedClock, HOSTILE, INVOICE_REQUEST,
  invoiceRef, lookupWith, okLine, padded, QUERY, Run, run, sandbox, SCOPE, sha256,
} from "./fixtures/knowledge/harness.js";

const OTHER = { principal: "other-reader", collection: "other-company" };
const OTHER_TEXT = "Invoices are due in 999 days.";
const OLD_TEXT = "Invoices are due in 30 days.";
const TEXT = "Synthetic test passage.";
const SECRET = "PLANTED-EXCEPTION-TEXT-51c2";

const LOOKUP_CALL = { name: "lookup", request: INVOICE_REQUEST, aborted: false };
const RECHECK_CALL = { name: "revalidate", binding: BINDING, ref: invoiceRef(), aborted: false };

/** Exit 1, the fixed error line for `code` and nothing on stdout. */
function expectRefused(r: Run, code: string): void {
  expect(r.code).toBe(1);
  expect(r.err).toBe(errorLine(code));
  expect(r.out).toBe("");
}

/** The store's transport, with `change` applied after the lookup reply and before the recheck. */
function between(store: DemoStore, change: () => void): Transport {
  return {
    lookup: async (request, signal) => {
      const reply = await store.transport.lookup(request, signal);
      change();
      return reply;
    },
    revalidate: store.transport.revalidate,
  };
}

/** The built-in lookup, with the recheck answered by `reply`. */
function recheckWith(reply: Uint8Array): Transport {
  return { lookup: createDemoTransport().lookup, revalidate: async () => reply };
}

function checkReply(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SCOPE, ...invoiceRef(), state: "current", ...change };
}

describe("knowledge recheck", () => {
  it("knowledge rechecks the same citation before any output", async () => {
    const changes: [string, (store: DemoStore) => void][] = [
      ["revoked", (store) => store.revoke("invoice-policy")],
      ["replaced", (store) => store.replace("invoice-policy", "Invoices are due in 60 days.")],
    ];
    for (const [label, change] of changes) {
      const store = createDemoStore();
      const r = await run(QUERY, between(store, () => change(store)));
      expect(r.code, label).toBe(1);
      expect(r.err, label).toBe(errorLine("STALE"));
      expect(r.out, label).toBe("");
      expect(r.calls, label).toEqual([LOOKUP_CALL, RECHECK_CALL]);
    }
    const control = await run(QUERY, between(createDemoStore(), () => {}));
    expect(control.code).toBe(0);
    expect(control.out).toBe(okLine("invoice-terms"));
    expect(control.err).toBe("");
    expect(control.calls).toEqual([LOOKUP_CALL, RECHECK_CALL]);
  });

  it("knowledge recheck: a citation that is gone at recheck is unavailable", async () => {
    const store = createDemoStore();
    const r = await run(QUERY, between(store, () => store.remove("invoice-policy")));
    expectRefused(r, "UNAVAILABLE");
    expect(r.calls).toEqual([LOOKUP_CALL, RECHECK_CALL]);
  });

  it("knowledge recheck: an outdated revision is never confirmed as current", async () => {
    const old = {
      document_id: "invoice-policy", revision: 1, fragment: "terms", sha256: sha256(OLD_TEXT),
      state: "current", excerpt: OLD_TEXT,
    };
    const transport: Transport = {
      lookup: async () => enc({ ...SCOPE, passages: [old] }),
      revalidate: createDemoTransport().revalidate,
    };
    const r = await run(QUERY, transport);
    expectRefused(r, "STALE");
    expect(r.calls).toHaveLength(2);
  });

  it("knowledge recheck: a lookup with no passage is unavailable and is not rechecked", async () => {
    const store = createDemoStore();
    store.remove("invoice-policy");
    const r = await run(QUERY, store.transport);
    expectRefused(r, "UNAVAILABLE");
    expect(r.calls).toEqual([LOOKUP_CALL]);
  });
});

describe("knowledge scope", () => {
  it("knowledge rejects wrong scope before accepting a passage", async () => {
    const wrong: [string, Record<string, string>][] = [
      ["principal", { principal: "other-reader" }],
      ["collection", { collection: "other-company" }],
    ];
    for (const [label, change] of wrong) {
      const base = createDemoTransport();
      const inLookup: Transport = {
        lookup: async (request, signal) => enc({ ...dec(await base.lookup(request, signal)), ...change }),
        revalidate: base.revalidate,
      };
      const first = await run(QUERY, inLookup);
      expect(first.code, `lookup ${label}`).toBe(1);
      expect(first.err, `lookup ${label}`).toBe(errorLine("DENIED"));
      expect(first.out, `lookup ${label}`).toBe("");
      expect(first.calls, `lookup ${label}`).toEqual([LOOKUP_CALL]);

      const second = await run(QUERY, recheckWith(enc(checkReply(change))));
      expect(second.code, `recheck ${label}`).toBe(1);
      expect(second.err, `recheck ${label}`).toBe(errorLine("DENIED"));
      expect(second.out, `recheck ${label}`).toBe("");
    }
  });

  it("knowledge scope: text of another principal never reaches output", async () => {
    // A service that searched the wrong scope: the built-in store answers for the other reader.
    const store = createDemoStore();
    const misrouted: Transport = {
      lookup: (request, signal) => store.transport.lookup({ ...request, ...OTHER } as never, signal),
      revalidate: store.transport.revalidate,
    };
    const served = dec(await misrouted.lookup(INVOICE_REQUEST as never, new AbortController().signal));
    expect(served.passages.map((p: { excerpt: string }) => p.excerpt)).toEqual([OTHER_TEXT]);
    const r = await run(QUERY, misrouted);
    expectRefused(r, "DENIED");
    expect(r.calls).toHaveLength(1);

    // Asked for its own scope, the store serves exactly the oracle passage and no other text.
    const own = await run(QUERY, createDemoTransport());
    expect(own.out).toBe(okLine("invoice-terms"));
  });

  it("knowledge scope: a recheck answered for another principal is denied", async () => {
    const store = createDemoStore();
    const otherRef = { document_id: "other-policy", revision: 1, fragment: "terms", sha256: sha256(OTHER_TEXT) };
    const misrouted: Transport = {
      lookup: store.transport.lookup,
      revalidate: (binding, _ref, signal) => {
        return store.transport.revalidate({ ...binding, ...OTHER } as never, otherRef, signal);
      },
    };
    const r = await run(QUERY, misrouted);
    expectRefused(r, "DENIED");
    expect(r.calls).toEqual([LOOKUP_CALL, RECHECK_CALL]);
  });
});

describe("knowledge quoted data", () => {
  it("knowledge source instructions stay quoted data", async () => {
    const store = createDemoStore();
    store.replace("invoice-policy", HOSTILE);
    const r = await run(QUERY, store.transport);
    const ref = { document_id: "invoice-policy", revision: 3, fragment: "terms", sha256: sha256(HOSTILE) };
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(JSON.stringify({
      status: "OK",
      mode: "synthetic",
      question_id: "invoice-terms",
      answer: HOSTILE,
      citation: { ...ref, retrieved_at: FIXED_TIME, checked_at: FIXED_TIME },
    }) + "\n");
    // The same request as for the harmless text, and one recheck of the returned citation.
    expect(r.calls).toEqual([LOOKUP_CALL, { name: "revalidate", binding: BINDING, ref, aborted: false }]);
  });
});

describe("knowledge transport bytes", () => {
  it("knowledge refuses invalid and oversized transport bytes", async () => {
    const zeroDigest = { sha256: "0".repeat(64) };
    const invalid: [string, Uint8Array][] = [
      ["empty object", enc({})],
      ["invalid UTF-8", new Uint8Array([0xff])],
      ["8193 zero bytes", new Uint8Array(8193)],
      ["digest of other text", enc(lookupWith(TEXT, zeroDigest))],
      ["line break in the excerpt", enc(lookupWith("bad\ncontrol"))],
    ];
    for (const [label, bytes] of invalid) {
      const r = await run(QUERY, echoTransport(bytes));
      expect(r.code, label).toBe(1);
      expect(r.err, label).toBe(errorLine("INVALID_RESPONSE"));
      expect(r.out, label).toBe("");
    }
    // The cap itself, with one valid reply at both lengths.
    const valid = enc(lookupWith(TEXT));
    const atCap = await run(QUERY, echoTransport(padded(valid, 8192)));
    expect(atCap.code).toBe(0);
    expect(JSON.parse(atCap.out).answer).toBe(TEXT);
    expectRefused(await run(QUERY, echoTransport(padded(valid, 8193))), "INVALID_RESPONSE");
  });

  const lookupRefused: [string, () => unknown, string][] = [
    ["with an unknown top-level key", () => enc({ ...lookupWith(TEXT), extra: 1 }), "INVALID_RESPONSE"],
    ["with a redirect field", () => enc({ ...lookupWith(TEXT), redirect: "https://example.invalid/" }), "INVALID_RESPONSE"],
    ["with an unknown passage key", () => enc(lookupWith(TEXT, { extra: 1 })), "INVALID_RESPONSE"],
    ["with a time field in the passage", () => enc(lookupWith(TEXT, { retrieved_at: FIXED_TIME })), "INVALID_RESPONSE"],
    ["with an empty document id", () => enc(lookupWith(TEXT, { document_id: "" })), "INVALID_RESPONSE"],
    ["with two passages", () => {
      const reply = lookupWith(TEXT);
      return enc({ ...reply, passages: [reply.passages[0], reply.passages[0]] });
    }, "INVALID_RESPONSE"],
    ["with no passage", () => enc({ ...SCOPE, passages: [] }), "UNAVAILABLE"],
    ["with a 1025-byte excerpt", () => enc(lookupWith("x".repeat(1023) + "é")), "INVALID_RESPONSE"],
    ["with revision 0", () => enc(lookupWith(TEXT, { revision: 0 })), "INVALID_RESPONSE"],
    ["with a negative revision", () => enc(lookupWith(TEXT, { revision: -1 })), "INVALID_RESPONSE"],
    ["with a revision past the safe integers", () => enc(lookupWith(TEXT, { revision: 2 ** 53 })), "INVALID_RESPONSE"],
    ["with a fractional revision", () => enc(lookupWith(TEXT, { revision: 1.5 })), "INVALID_RESPONSE"],
    ["with a 63-character digest", () => {
      return enc(lookupWith(TEXT, { sha256: sha256(TEXT).slice(1) }));
    }, "INVALID_RESPONSE"],
    ["with an upper-case digest", () => {
      return enc(lookupWith(TEXT, { sha256: sha256(TEXT).toUpperCase() }));
    }, "INVALID_RESPONSE"],
    ["with state revoked", () => enc(lookupWith(TEXT, { state: "revoked" })), "INVALID_RESPONSE"],
    ["with an unknown state", () => enc(lookupWith(TEXT, { state: "superseded" })), "INVALID_RESPONSE"],
    ["with an escape character in the excerpt", () => enc(lookupWith("clear \u001b[2J screen")), "INVALID_RESPONSE"],
    ["with a delete character in the excerpt", () => enc(lookupWith("del \u007f here")), "INVALID_RESPONSE"],
    ["with a C1 control in the excerpt", () => enc(lookupWith("csi \u009b here")), "INVALID_RESPONSE"],
    ["with half a surrogate pair in the excerpt", () => enc(lookupWith("half \ud83d pair")), "INVALID_RESPONSE"],
    ["with an invalid byte in the excerpt and the digest of its repaired text", () => {
      // 0x7e stands in for the bad byte until the reply is serialized, then becomes 0xff.
      const bytes = enc(lookupWith("bad ~ byte", { sha256: sha256("bad \ufffd byte") }));
      bytes[bytes.indexOf(0x7e)] = 0xff;
      return bytes;
    }, "INVALID_RESPONSE"],
    ["with an empty excerpt", () => enc(lookupWith("")), "INVALID_RESPONSE"],
    ["with schema version 2", () => enc({ ...lookupWith(TEXT), schema_version: 2 }), "INVALID_RESPONSE"],
    ["with an upper-case principal", () => enc({ ...lookupWith(TEXT), principal: "Demo-Reader" }), "INVALID_RESPONSE"],
    ["with a 49-character document id", () => enc(lookupWith(TEXT, { document_id: "d".repeat(49) })), "INVALID_RESPONSE"],
    ["with an upper-case fragment", () => enc(lookupWith(TEXT, { fragment: "Notice" })), "INVALID_RESPONSE"],
    ["with a null passage", () => enc({ ...SCOPE, passages: [null] }), "INVALID_RESPONSE"],
    ["with passages that are not a list", () => enc({ ...SCOPE, passages: {} }), "INVALID_RESPONSE"],
    ["that is null", () => enc(null), "INVALID_RESPONSE"],
    ["that is not JSON", () => new TextEncoder().encode("{"), "INVALID_RESPONSE"],
    ["that starts with a byte-order mark", () => {
      const body = enc(lookupWith(TEXT));
      const bytes = new Uint8Array(body.length + 3);
      bytes.set([0xef, 0xbb, 0xbf]);
      bytes.set(body, 3);
      return bytes;
    }, "INVALID_RESPONSE"],
    ["delivered as an ArrayBuffer", () => enc(lookupWith(TEXT)).slice().buffer, "INVALID_RESPONSE"],
  ];

  it.each(lookupRefused)("knowledge refuses a lookup reply %s", async (_name, reply, code) => {
    const r = await run(QUERY, echoTransport(reply() as Uint8Array));
    expectRefused(r, code);
  });

  const lookupAccepted: [string, string][] = [
    ["with a 1024-byte excerpt", "x".repeat(1022) + "é"],
    ["with a full surrogate pair in the excerpt", "Synthetic 😀 passage."],
  ];

  it.each(lookupAccepted)("knowledge accepts a lookup reply %s", async (_name, excerpt) => {
    const r = await run(QUERY, echoTransport(enc(lookupWith(excerpt))));
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).answer).toBe(excerpt);
  });

  const recheckRefused: [string, () => Uint8Array, string][] = [
    ["reporting revoked", () => enc(checkReply({ state: "revoked" })), "STALE"],
    ["with a changed digest", () => enc(checkReply({ sha256: sha256("Invoices are due in 60 days.") })), "STALE"],
    ["with a changed fragment", () => enc(checkReply({ fragment: "summary" })), "STALE"],
    ["with a changed document", () => enc(checkReply({ document_id: "invoice-archive" })), "STALE"],
    ["with a changed revision", () => enc(checkReply({ revision: 3 })), "STALE"],
    ["with an unknown key", () => enc(checkReply({ extra: 1 })), "INVALID_RESPONSE"],
    ["with a redirect field", () => enc(checkReply({ redirect: "https://example.invalid/" })), "INVALID_RESPONSE"],
    ["with an unknown state", () => enc(checkReply({ state: "superseded" })), "INVALID_RESPONSE"],
    ["with an upper-case digest", () => {
      return enc(checkReply({ sha256: invoiceRef().sha256.toUpperCase() }));
    }, "INVALID_RESPONSE"],
    ["with revision 0", () => enc(checkReply({ revision: 0 })), "INVALID_RESPONSE"],
    ["with schema version 2", () => enc(checkReply({ schema_version: 2 })), "INVALID_RESPONSE"],
    ["with an upper-case principal", () => enc(checkReply({ principal: "Demo-Reader" })), "INVALID_RESPONSE"],
    ["with an upper-case document id", () => enc(checkReply({ document_id: "Invoice-Policy" })), "INVALID_RESPONSE"],
    ["that is invalid UTF-8", () => new Uint8Array([0xff]), "INVALID_RESPONSE"],
    ["of 8193 bytes", () => padded(enc(checkReply()), 8193), "INVALID_RESPONSE"],
  ];

  it.each(recheckRefused)("knowledge refuses a recheck reply %s", async (_name, reply, code) => {
    const r = await run(QUERY, recheckWith(reply()));
    expectRefused(r, code);
    expect(r.calls).toEqual([LOOKUP_CALL, RECHECK_CALL]);
  });

  it("knowledge accepts a recheck reply of exactly 8192 bytes", async () => {
    const r = await run(QUERY, recheckWith(padded(enc(checkReply()), 8192)));
    expect(r.code).toBe(0);
    expect(r.out).toBe(okLine("invoice-terms"));
    expect(r.err).toBe("");
  });

  it("knowledge caps the success line at 8192 bytes", () => {
    const o = EXPECTED["invoice-terms"];
    const citation = {
      document_id: o.document_id, revision: o.revision, fragment: o.fragment, sha256: o.sha256,
      retrieved_at: FIXED_TIME, checked_at: FIXED_TIME,
    };
    const output = (answer: string) => {
      return { status: "OK", mode: "synthetic", question_id: "invoice-terms", answer, citation } as const;
    };
    /** The serialized line, or what was thrown instead of it. */
    const attempt = (answer: string): unknown => {
      try {
        return serializeOutput(output(answer));
      } catch (e) {
        return e;
      }
    };
    const room = 8192 - Buffer.byteLength(JSON.stringify(output("")), "utf8");
    const atCap = JSON.stringify(output("x".repeat(room)));
    expect(Buffer.byteLength(atCap, "utf8")).toBe(8192);
    expect(attempt("x".repeat(room))).toBe(atCap);
    expect(attempt("x".repeat(room + 1))).toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("knowledge failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything written through the console or the process streams while `fn` runs. */
  async function sideOutput(fn: () => Promise<void>): Promise<string> {
    const seen: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void seen.push(...args));
    }
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        seen.push(chunk);
        return true;
      });
    }
    try {
      await fn();
    } finally {
      vi.restoreAllMocks();
    }
    return seen.map((v) => (v instanceof Error ? `${v.message} ${v.stack}` : String(v))).join("\n");
  }

  const failing: [string, (base: Transport) => Transport, number][] = [
    ["a lookup that rejects", (base) => ({ ...base, lookup: () => Promise.reject(new Error(SECRET)) }), 1],
    ["a lookup that throws at once", (base) => ({
      ...base,
      lookup: () => {
        throw new Error(SECRET);
      },
    }), 1],
    ["a recheck that rejects", (base) => ({ ...base, revalidate: () => Promise.reject(new Error(SECRET)) }), 2],
    ["a recheck that throws at once", (base) => ({
      ...base,
      revalidate: () => {
        throw new Error(SECRET);
      },
    }), 2],
  ];

  it.each(failing)("knowledge reports %s as unavailable, without its message", async (_name, broken, calls) => {
    let r: Run | undefined;
    const side = await sideOutput(async () => {
      r = await run(QUERY, broken(createDemoTransport()));
    });
    expectRefused(r!, "UNAVAILABLE");
    expect(r!.calls).toHaveLength(calls);
    expect(r!.out + r!.err + side).not.toContain(SECRET);
    expect(side).toBe("");
  });

  it("knowledge reports a transport failure as unavailable even when it carries another code", async () => {
    const base = createDemoTransport();
    const first = await run(QUERY, { ...base, lookup: () => Promise.reject(new Refusal("DENIED")) });
    expectRefused(first, "UNAVAILABLE");
    const second = await run(QUERY, { ...base, revalidate: () => Promise.reject(new Refusal("STALE")) });
    expectRefused(second, "UNAVAILABLE");
  });

  it("knowledge reports an invalid clock as unavailable, with no output", async () => {
    const r = await run(QUERY, createDemoTransport(), () => new Date(Number.NaN));
    expectRefused(r, "UNAVAILABLE");
  });

  it("knowledge reports a clock outside the four-digit years as unavailable", async () => {
    const r = await run(QUERY, createDemoTransport(), () => new Date(Date.UTC(10000, 0, 1)));
    expectRefused(r, "UNAVAILABLE");
  });

  it("knowledge reports a throwing clock as unavailable, without its message", async () => {
    let r: Run | undefined;
    const side = await sideOutput(async () => {
      r = await run(QUERY, createDemoTransport(), () => {
        throw new Error(SECRET);
      });
    });
    expectRefused(r!, "UNAVAILABLE");
    expect(r!.out + r!.err + side).not.toContain(SECRET);
  });

  it("knowledge stamps the retrieval and check times from the clock, in order", async () => {
    const times = ["2026-10-13T12:00:00.000Z", "2026-10-13T12:00:01.250Z"];
    let reads = 0;
    // How many clock readings had been taken when each reply arrived.
    const readsAt: Record<string, number> = {};
    const base = createDemoTransport();
    const transport: Transport = {
      lookup: async (request, signal) => {
        const reply = await base.lookup(request, signal);
        readsAt.lookup = reads;
        return reply;
      },
      revalidate: async (binding, ref, signal) => {
        const reply = await base.revalidate(binding, ref, signal);
        readsAt.revalidate = reads;
        return reply;
      },
    };
    const r = await run(QUERY, transport, () => new Date(times[reads++]));
    expect(r.code).toBe(0);
    expect(r.out).toBe(okLine("invoice-terms", times[0], times[1]));
    expect(reads).toBe(2);
    // The first reading follows the lookup reply and the second follows the recheck reply.
    expect(readsAt).toEqual({ lookup: 0, revalidate: 1 });
  });
});

describe("knowledge shared state", () => {
  it("knowledge shared result is independent of personal state", async () => {
    const before = { cwd: process.cwd(), env: { ...process.env } };
    const base = sandbox();
    const seen: { cwd: string; home: string | undefined }[] = [];
    const runs: Run[] = [];
    try {
      for (const tag of ["A", "B"]) {
        const c = canary(base, tag);
        Object.assign(process.env, c.env);
        process.chdir(c.cwd);
        const inner = createDemoTransport();
        const transport: Transport = {
          lookup: (request, signal) => {
            seen.push({ cwd: process.cwd(), home: process.env.HOME });
            return inner.lookup(request, signal);
          },
          revalidate: inner.revalidate,
        };
        runs.push(await run(QUERY, transport, fixedClock));
      }
    } finally {
      process.chdir(before.cwd);
      for (const key of Object.keys(process.env)) if (!(key in before.env)) delete process.env[key];
      Object.assign(process.env, before.env);
      rmSync(base, { recursive: true, force: true });
    }
    // The two runs really saw different personal surroundings.
    expect(seen).toHaveLength(2);
    expect(seen[0].cwd).not.toBe(seen[1].cwd);
    expect(seen[0].home).not.toBe(seen[1].home);
    expect(seen[0].home).toContain("home-A");
    // Same request, same bytes out, same exit.
    const [a, b] = runs;
    expect(a.calls).toEqual([LOOKUP_CALL, RECHECK_CALL]);
    expect(b.calls).toEqual(a.calls);
    expect(a.out).toBe(okLine("invoice-terms"));
    expect(b.out).toBe(a.out);
    expect([a.err, b.err]).toEqual(["", ""]);
    expect([a.code, b.code]).toEqual([0, 0]);
    // The surroundings are back as they were.
    expect(process.cwd()).toBe(before.cwd);
    expect({ ...process.env }).toEqual(before.env);
  });
});
