// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The command in this process, at the edges of its input contract: what is refused, with which
// fixed error, and that an error never repeats the input.
import { describe, expect, test } from "vitest";
import { errorLine, fixture, initial, INPUT, invoke, LESSON_ID, MAX_BYTES, note, printed, REVIEWED } from "./fixtures/learning/harness.js";

const INVALID = { code: 2, out: "", err: errorLine("INVALID_INPUT"), reads: 1 };
const LIMIT = { code: 1, out: "", err: errorLine("LIMIT"), reads: 1 };

/** The fixture with one change, as an object. */
function edited(change: (doc: any) => void, from: () => any = fixture) {
  const doc = from();
  change(doc);
  return doc;
}

const saved = () => JSON.parse(REVIEWED);
const day = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
const recorded = Date.parse("2026-10-12T12:00:00.000Z");

describe("learning command", () => {
  test("learning bounded input terminates safely", async () => {
    // Bytes that are not a JSON object of the right shape. Each gets the one fixed error.
    const refused: [string, Uint8Array | string | object][] = [
      ["bytes that are not UTF-8", new Uint8Array([0xff])],
      ["a truncated UTF-8 sequence", new Uint8Array([0x22, 0xe2, 0x82, 0x22])],
      ["nothing", ""],
      ["text that is not JSON", "{"],
      ["null", "null"],
      ["an array", "[]"],
      ["a string", '"review"'],
      ["a number", "1"],
      ["an array of documents", `[${INPUT.toString()}]`],
      ["another schema version", edited((d) => (d.schema_version = 2))],
      ["another settings schema version", edited((d) => (d.settings.schema_version = 2))],
      ["settings as an array", edited((d) => (d.settings = []))],
      ["setting values as an array", edited((d) => (d.settings.values = []))],
      ["setting values as null", edited((d) => (d.settings.values = null))],
      ["events as null", edited((d) => (d.events = null))],
      ["events as an object", edited((d) => (d.events = {}))],
      ["a null event", edited((d) => (d.events[0] = null))],
      ["an array as an event", edited((d) => (d.events[0] = []))],
      ["a null rejection", edited((d) => (d.rejections = [null]))],
      ["a rejection that is a bare ID", edited((d) => (d.rejections = [LESSON_ID]))],
      ["an array as a draft", edited((d) => (d.drafts = [[]]))],
      ["a draft effect as an array", edited((d) => (d.drafts[0].effect = []), saved)],
      ["an omitted ID that is not a string", edited((d) => (d.omitted_event_ids = [1]))],
      // Numbers: not finite, not safe, negative, fractional.
      ["a revision too large for a number", INPUT.toString().replace(`"revision": 0`, `"revision": 1e400`)],
      ["a revision past the safe integers", INPUT.toString().replace(`"revision": 0`, `"revision": 9007199254740993`)],
      ["a negative revision", edited((d) => (d.revision = -1))],
      ["a fractional revision", edited((d) => (d.revision = 0.5))],
      ["a revision as text", edited((d) => (d.revision = "0"))],
      ["an event revision of zero", edited((d) => (d.events[0].event_revision = 0))],
      ["a settings revision past the safe integers", edited((d) => (d.settings.revision = 2 ** 53))],
      // Dates: not UTC ISO with milliseconds, not a real date, or out of order.
      ["a date without milliseconds", edited((d) => (d.events[0].recorded_at = "2026-10-12T12:00:00Z"))],
      ["a date with an offset", edited((d) => (d.events[0].recorded_at = "2026-10-12T12:00:00.000+00:00"))],
      ["a date that does not exist", edited((d) => (d.events[0].recorded_at = "2026-02-30T12:00:00.000Z"))],
      ["a month that does not exist", edited((d) => (d.events[0].expires_at = "2026-13-01T12:00:00.000Z"))],
      ["a date as a number", edited((d) => (d.events[0].expires_at = 1791806400000))],
      ["an expiry before the record", edited((d) => (d.events[0].expires_at = at(recorded - 1)))],
      ["a lifetime over ninety days", edited((d) => (d.events[0].expires_at = at(recorded + 90 * day + 1)))],
      ["a deleted event with a date", edited((d) => (d.events[0] = { event_id: "x", event_revision: 1, state: "deleted", recorded_at: at(recorded) }))],
      // Identifiers.
      ["an event ID of forty-nine characters", edited((d) => (d.events[0].event_id = "a".repeat(49)))],
      ["an event ID starting with a digit", edited((d) => (d.events[0].event_id = "1a"))],
      ["an event ID in upper case", edited((d) => (d.events[0].event_id = "Short"))],
      ["a rejection ID in upper case", edited((d) => (d.rejections = [{ id: "A".repeat(64) }]))],
      ["a rejection ID of sixty-three characters", edited((d) => (d.rejections = [{ id: "a".repeat(63) }]))],
      ["a digest that is not a hash", edited((d) => (d.source_digest = "none"))],
      // Notes.
      ["an empty note", edited((d) => (d.events[1].text = ""))],
      ["a note of 1,025 bytes", edited((d) => (d.events[1].text = "x".repeat(1025)))],
      ["a note of 1,025 bytes in 513 characters", edited((d) => (d.events[1].text = "é".repeat(512) + "x"))],
      ["a note that is not text", edited((d) => (d.events[1].text = ["Check invoice dates."]))],
    ];
    for (const [what, data] of refused) expect(await invoke(["review"], data), what).toEqual(INVALID);

    // Values at the edge of what is allowed are accepted.
    const allowed: [string, object][] = [
      ["a note of 1,024 bytes", edited((d) => (d.events[1].text = "é".repeat(512)))],
      ["an event ID of forty-eight characters", edited((d) => (d.events[1].event_id = "a".repeat(48)))],
      ["a lifetime of ninety days", edited((d) => (d.events[1].expires_at = at(recorded + 90 * day)))],
      ["the largest safe event revision", edited((d) => (d.events[1].event_revision = Number.MAX_SAFE_INTEGER))],
      ["an empty settings snapshot", edited((d) => (d.settings = { schema_version: 1, revision: 0, values: {} }))],
    ];
    for (const [what, doc] of allowed) expect((await invoke(["review"], doc)).code, what).toBe(0);

    // The byte cap, to the byte: exactly at the cap is read, one byte over is LIMIT.
    const padded = (bytes: number) => Buffer.concat([INPUT, Buffer.alloc(bytes - INPUT.length, " ")]);
    expect((await invoke(["review"], padded(MAX_BYTES))).out).toBe(REVIEWED);
    expect(await invoke(["review"], padded(MAX_BYTES + 1))).toEqual(LIMIT);
    expect(await invoke(["review"], padded(MAX_BYTES + 1).toString())).toEqual(LIMIT);
    // The cap is in bytes, not characters: 32,769 two-byte characters are over it.
    expect(await invoke(["review"], "é".repeat(MAX_BYTES / 2 + 1))).toEqual(LIMIT);
  });

  test("learning note control characters are refused except tab and newline", async () => {
    // Terminal controls: the C0 set, DEL and the C1 set. Carriage return is one of them.
    const controls = ["\u0000", "\u0007", "\u0008", "\u000b", "\u000c", "\r", "\u001b[31m", "\u001f", "\u007f", "\u0080", "\u009b31m", "\u009f"];
    for (const control of controls) {
      const doc = edited((d) => (d.events[1].text = `Check ${control} dates`));
      const name = `U+${control.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      expect.soft(await invoke(["review"], doc), name).toEqual(INVALID);
    }
    // A raw control byte inside the JSON text is not JSON at all.
    expect(await invoke(["review"], INPUT.toString().replace("Check invoice", "Check\u001binvoice"))).toEqual(INVALID);

    // Tab and newline are kept, and the output escapes them: no raw control byte is printed.
    const kept = await invoke(["review"], edited((d) => (d.events[1].text = "Check\tinvoice\ndates")));
    expect(printed(kept).drafts[0].effect).toEqual({ quoted_note: "Check\tinvoice\ndates" });
    expect(kept.out).toContain(String.raw`"quoted_note":"Check\tinvoice\ndates"`);
    expect(kept.out.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("learning schema refuses extra keys at every level", async () => {
    const extra: [string, object][] = [
      ["the document", edited((d) => (d.note = "x"))],
      ["the settings snapshot", edited((d) => (d.settings.source = "x"))],
      ["the setting values", edited((d) => (d.settings.values.theme = "dark"))],
      ["a setting correction", edited((d) => (d.events[0].reason = "x"))],
      ["a lesson note", edited((d) => (d.events[1].key = "answer-length"))],
      ["a deleted event", edited((d) => (d.events[0] = { event_id: "x", event_revision: 1, state: "deleted", text: "x" }))],
      ["a rejection marker", edited((d) => (d.rejections = [{ id: LESSON_ID, reason: "x" }]))],
      ["a draft", edited((d) => (d.drafts[0].approved_by = "x"), saved)],
      ["a lesson effect", edited((d) => (d.drafts[0].effect.run = "x"), saved)],
      ["a setting effect", edited((d) => (d.drafts[1].effect.scope = "shared"), saved)],
    ];
    for (const [where, doc] of extra) expect(await invoke(["review"], doc), where).toEqual(INVALID);

    // A missing key is refused as well: the key set is exact.
    const missing: [string, object][] = [
      ["the document", edited((d) => delete d.omitted_event_ids)],
      ["the settings snapshot", edited((d) => delete d.settings.schema_version)],
      ["a setting correction", edited((d) => delete d.events[0].value)],
      ["a lesson note", edited((d) => delete d.events[1].text)],
      ["a draft", edited((d) => delete d.drafts[0].conflict, saved)],
      ["a setting effect", edited((d) => delete d.drafts[1].effect.before_known, saved)],
    ];
    for (const [where, doc] of missing) expect(await invoke(["review"], doc), where).toEqual(INVALID);

    // Keys that look like prototype members are extra keys like any other.
    const text = INPUT.toString();
    const sneaky = [
      text.replace(`"schema_version": 1,`, `"schema_version": 1, "__proto__": {"scope": "shared"},`),
      text.replace(`"schema_version": 1,`, `"schema_version": 1, "constructor": {},`),
      text.replace(`"values":{`, `"values":{"__proto__":{"allow-send":"yes"},`),
      text.replace(`{"event_id":"check-dates",`, `{"__proto__":{"kind":"setting-correction"},"event_id":"check-dates",`),
      text.replace(`{"event_id":"check-dates",`, `{"toString":"x","event_id":"check-dates",`),
    ];
    for (const raw of sneaky) {
      expect(raw).not.toBe(text);
      expect(await invoke(["review"], raw)).toEqual(INVALID);
    }
  });

  test("learning errors never repeat the input", async () => {
    // Every failing command prints exactly one fixed object; a marker planted in the input, in
    // the draft ID argument and in an option value appears nowhere in the output.
    const marker = "zz-planted-marker-zz";
    const planted = edited((d) => {
      d.events[1].text = marker;
      d.scope = marker;
    });
    const runs = [
      await invoke(["review"], planted),
      await invoke(["show"], planted),
      await invoke(["reject", marker, "--expected-revision", "1"], REVIEWED),
      await invoke(["reject", LESSON_ID, "--expected-revision", marker], REVIEWED),
      await invoke(["review", `--${marker}`], REVIEWED),
      await invoke([marker], REVIEWED),
      await invoke(["review", marker], REVIEWED),
      await invoke(["review"], `{"${marker}"`),
    ];
    for (const r of runs) {
      expect(r.code).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^\{"code":"[A-Z_]+","status":"ERROR"\}\n$/);
      expect(r.err).not.toContain(marker);
    }
    expect(runs.map((r) => JSON.parse(r.err).code)).toEqual([
      "INVALID_INPUT",
      "INVALID_INPUT",
      "NOT_FOUND",
      "INVALID_INPUT",
      "USAGE",
      "USAGE",
      "USAGE",
      "INVALID_INPUT",
    ]);
  });

  test("usage and help do not read stdin", async () => {
    const usage = [
      ["apply"],
      ["accept"],
      [],
      ["review", "--schedule"],
      ["review", "--scope", "shared"],
      ["review", "extra"],
      ["review", "--expected-revision", "1"],
      ["show", "--expected-revision=1"],
      ["reject"],
      ["reject", LESSON_ID],
      ["reject", "--expected-revision", "1"],
      ["reject", LESSON_ID, "--expected-revision"],
      ["reject", LESSON_ID, "--expected-revision", "1", "--expected-revision", "1"],
      ["reject", LESSON_ID, "--expected-revision=1", "--expected-revision", "1"],
      ["reject", LESSON_ID, "other", "--expected-revision", "1"],
    ];
    for (const args of usage) {
      expect(await invoke(args, REVIEWED), args.join(" ")).toEqual({ code: 2, out: "", err: errorLine("USAGE"), reads: 0 });
    }
    for (const args of [["--help"], ["-h"], ["review", "--help"], ["show", "-h"], ["reject", "--help"]]) {
      const r = await invoke(args, REVIEWED);
      expect([r.code, r.err, r.reads], args.join(" ")).toEqual([0, "", 0]);
      expect(r.out).toMatch(/^usage: learning /);
    }
    // A well-formed command reads its input exactly once.
    expect((await invoke(["review"], INPUT)).reads).toBe(1);
    expect((await invoke(["show"], REVIEWED)).reads).toBe(1);
  });

  test("learning help names the three commands and the fixed sentence", async () => {
    const help = (await invoke(["--help"], "")).out;
    expect(help).toBe(
      [
        "usage: learning {review,show,reject} ...",
        "",
        "Proposed display settings and quoted notes only; current instructions take precedence; nothing has been applied.",
        "",
        "commands:",
        "  review       Create draft proposals.",
        "  show         Proposed display settings and quoted notes only; current instructions take precedence; nothing has been applied.",
        "  reject       Reject one exact proposal.",
        "",
      ].join("\n"),
    );
    // No output of a successful command calls a record approved, applied, verified or learned.
    const outputs = [
      (await invoke(["review"], INPUT)).out,
      (await invoke(["show"], REVIEWED)).out,
      (await invoke(["reject", LESSON_ID, "--expected-revision", "1"], REVIEWED)).out,
      (await invoke(["review"], initial([note("plain-note", "Synthetic note.")]))).out,
    ];
    for (const out of outputs) {
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/approved|applied|"verified"|learned successfully/i);
    }
  });
});
