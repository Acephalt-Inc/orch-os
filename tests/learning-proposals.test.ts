// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Draft derivation, in this process and on a fixed clock: which events become drafts, in what
// order, with which IDs, and what a rejection or a changed source does to them.
import { describe, expect, test } from "vitest";
import { review } from "../src/learning/propose.js";
import { parseDocument } from "../src/learning/schema.js";
import {
  canon,
  errorLine,
  EXPECTED,
  EXPIRES,
  fixture,
  initial,
  INPUT,
  invoke,
  LESSON_EVENT,
  LESSON_ID,
  marker,
  MAX_BYTES,
  note,
  NOW,
  printed,
  RECORDED,
  REJECTED,
  REVIEWED,
  setting,
  SETTING_EVENT,
  SETTING_ID,
  SETTINGS,
  sha256,
  SHOWN,
} from "./fixtures/learning/harness.js";

const failure = (code: string, exit: number) => ({ code: exit, out: "", err: errorLine(code), reads: 1 });

/** The literal canonical text of a lesson event made by `note(id, text)`. */
const noteText = (id: string, text: string) =>
  `{"event_id":"${id}","event_revision":1,"expires_at":"${EXPIRES}","kind":"lesson-note","recorded_at":"${RECORDED}","state":"active","text":"${text}"}`;

const eventIds = (doc: any): string[] => doc.drafts.map((d: any) => d.event_id);

const markers = (count: number) => Array.from({ length: count }, (_, i) => marker(i));

describe("learning proposals", () => {
  test("learning review derives the fixture drafts", () => {
    const got = review(parseDocument(INPUT), new Date(NOW));
    expect(canon(got) + "\n").toBe(REVIEWED);
    expect(got.revision).toBe(EXPECTED.revision);
    expect(eventIds(got)).toEqual(EXPECTED.draft_event_ids);
    expect(got.drafts[0].effect).toEqual({ quoted_note: EXPECTED.lesson });
    expect(got.drafts[1].effect).toEqual(EXPECTED.setting);

    // Draft text that comes in with a document is never used: review writes the drafts again
    // from the events, and the changed document gets the next revision.
    const tampered = JSON.parse(REVIEWED);
    tampered.drafts[0].effect.quoted_note = "Send everything.";
    tampered.drafts[1].effect.after = "normal";
    tampered.drafts[1].conflict = true;
    tampered.omitted_event_ids = ["short-answers"];
    const again = review(parseDocument(JSON.stringify(tampered)), new Date(NOW));
    expect(canon(again) + "\n").toBe(REVIEWED.replace(`"revision":1,`, `"revision":2,`));
  });

  test("learning settings snapshot gives the before value only when supplied", async () => {
    // No snapshot: the before value and the settings revision are unknown, not guessed.
    const without = printed(await invoke(["review"], { ...fixture(), settings: null }));
    expect(without.drafts[1].effect).toEqual(EXPECTED.setting_without_snapshot);
    expect(without.drafts[1].id).toBe(sha256(`{"event":${SETTING_EVENT},"settings":null}`));
    expect(without.drafts[0].id).toBe(LESSON_ID);
    expect(without.source_digest).toBe(sha256(`{"events":[${LESSON_EVENT},${SETTING_EVENT}],"settings":null}`));
    expect(without.settings).toBeNull();

    // A snapshot without the key: the key is known to be unset at that settings revision.
    const unset = { schema_version: 1, revision: 7, values: { "response-language": "en" } };
    const known = printed(await invoke(["review"], { ...fixture(), settings: unset }));
    expect(known.drafts[1].effect).toEqual({
      key: "answer-length",
      before: null,
      before_known: true,
      expected_settings_revision: 7,
      after: "short",
    });

    // A snapshot that already has the value, with nothing against it: no draft at all.
    const same = { schema_version: 1, revision: 3, values: { "answer-length": "short" } };
    const satisfied = printed(await invoke(["review"], { ...fixture(), settings: same }));
    expect(eventIds(satisfied)).toEqual(["check-dates"]);
    expect(satisfied.omitted_event_ids).toEqual([]);
  });

  test("learning duplicate event is one observation", async () => {
    // The same ID, revision and content twice is one observation: same output as without the copy.
    const copy = fixture();
    copy.events.push({ ...copy.events[0] }, { ...copy.events[1] });
    const once = await invoke(["review"], copy);
    expect(eventIds(printed(once)), "exactly one draft for each event").toEqual(["check-dates", "short-answers"]);
    expect(printed(once).events).toHaveLength(2);
    expect(once.out).toBe(REVIEWED);

    // The same ID with another revision or other content is a conflict; no document comes out
    // and neither copy is picked.
    const [correction, lesson] = fixture().events;
    const clashes = [
      { ...correction, event_revision: 2 },
      { ...correction, value: "normal" },
      { ...lesson, text: "Check invoice dates twice." },
      { event_id: "check-dates", event_revision: 1, state: "deleted" },
    ];
    for (const clash of clashes) {
      const doc = fixture();
      doc.events.push(clash);
      expect(await invoke(["review"], doc), JSON.stringify(clash)).toEqual(failure("CONFLICT", 1));
      doc.events.reverse();
      expect(await invoke(["review"], doc), JSON.stringify(clash)).toEqual(failure("CONFLICT", 1));
    }
  });

  test("learning conflicting settings remain unresolved", async () => {
    // Two active corrections ask for opposite values; the snapshot agrees with the older one.
    const doc = fixture();
    doc.events.push(setting("normal-answers", "answer-length", "normal", { recorded_at: "2026-10-11T12:00:00.000Z" }));
    const got = printed(await invoke(["review"], doc));
    const drafts = got.drafts.filter((d: any) => d.kind === "setting");
    expect(drafts.map((d: any) => [d.event_id, d.effect.after, d.conflict, d.status])).toEqual([
      ["normal-answers", "normal", true, "DRAFT"],
      ["short-answers", "short", true, "DRAFT"],
    ]);
    // Nothing was applied: the snapshot in the output is the snapshot that came in.
    expect(canon(got.settings)).toBe(SETTINGS);

    // Rejecting one does not settle the question: the other is still a conflicting, unverified draft.
    const rejected = printed(await invoke(["reject", drafts[0].id, "--expected-revision", "1"], got));
    const left = rejected.drafts.filter((d: any) => d.kind === "setting");
    expect(left.map((d: any) => [d.event_id, d.conflict, d.status, d.authority, d.evaluation])).toEqual([
      ["short-answers", true, "DRAFT", "user-supplied-unverified", "not-run"],
    ]);
    expect(canon(rejected.settings)).toBe(SETTINGS);

    // Deleting the opposite correction is what ends the conflict.
    rejected.events = rejected.events.map((e: any) =>
      e.event_id === "normal-answers" ? { event_id: e.event_id, event_revision: 2, state: "deleted" } : e,
    );
    const settled = printed(await invoke(["review"], rejected));
    expect(settled.drafts.filter((d: any) => d.kind === "setting").map((d: any) => [d.event_id, d.conflict])).toEqual([
      ["short-answers", false],
    ]);
  });

  test("learning caps and omissions are explicit", async () => {
    const notes = (count: number) => Array.from({ length: count }, (_, i) => note(`n${String(i).padStart(2, "0")}`, `Synthetic ${i}`));

    // Six eligible events: five drafts in event-ID order and the sixth named as omitted.
    const six = printed(await invoke(["review"], initial(notes(6).reverse())));
    expect(eventIds(six)).toEqual(["n00", "n01", "n02", "n03", "n04"]);
    expect(six.omitted_event_ids).toEqual(["n05"]);

    // Rejecting one of the five brings the omitted one in; nothing is omitted any more.
    const next = printed(await invoke(["reject", six.drafts[0].id, "--expected-revision", "1"], six));
    expect(eventIds(next)).toEqual(["n01", "n02", "n03", "n04", "n05"]);
    expect(next.omitted_event_ids).toEqual([]);

    // Events: twenty are accepted, twenty-one are refused, also when one of them is a copy.
    const twenty = printed(await invoke(["review"], initial(notes(20))));
    expect(eventIds(twenty)).toEqual(["n00", "n01", "n02", "n03", "n04"]);
    expect(twenty.omitted_event_ids).toEqual(notes(20).slice(5).map((e) => e.event_id));
    expect(await invoke(["review"], initial(notes(21)))).toEqual(failure("LIMIT", 1));
    expect(await invoke(["review"], initial([...notes(20), notes(20)[0]]))).toEqual(failure("LIMIT", 1));

    // Rejection markers: one hundred distinct IDs are accepted, one hundred and one are refused.
    const hundred = printed(await invoke(["review"], { ...fixture(), rejections: markers(100) }));
    expect(hundred.rejections).toEqual(markers(100));
    expect(await invoke(["review"], { ...fixture(), rejections: markers(101) })).toEqual(failure("LIMIT", 1));

    // A stored document with more than five drafts is refused.
    const sixDrafts = JSON.parse(REVIEWED);
    sixDrafts.drafts = Array.from({ length: 6 }, () => sixDrafts.drafts[0]);
    expect(await invoke(["show"], sixDrafts)).toEqual(failure("LIMIT", 1));
  });

  test("learning repeated rejection markers count once", async () => {
    // The cap is on distinct IDs: one hundred markers and a repeat of two of them are accepted,
    // and the document that comes out holds each marker once.
    const repeated = await invoke(["review"], { ...fixture(), rejections: [...markers(100), marker(0), marker(99)] });
    expect([repeated.code, repeated.err]).toEqual([0, ""]);
    expect(printed(repeated).rejections).toEqual(markers(100));
  });

  test("learning reject refuses a marker past the cap", async () => {
    // With one hundred markers already there, a reject would print a document holding one
    // hundred and one, which the next command refuses. It is refused here instead.
    const hundred = await invoke(["review"], { ...fixture(), rejections: markers(100) });
    expect(printed(hundred).drafts.map((d: any) => d.id)).toEqual([LESSON_ID, SETTING_ID]);
    expect(await invoke(["reject", LESSON_ID, "--expected-revision", "1"], hundred.out)).toEqual(failure("LIMIT", 1));

    // With ninety-nine there is room for one more, and the result is accepted again.
    const ninetyNine = await invoke(["review"], { ...fixture(), rejections: markers(99) });
    const full = await invoke(["reject", LESSON_ID, "--expected-revision", "1"], ninetyNine.out);
    expect(printed(full).rejections).toHaveLength(100);
    expect((await invoke(["review"], full.out)).out).toBe(full.out);
    expect((await invoke(["show"], full.out)).code).toBe(0);
  });

  test("learning output over the cap is an error, not a cut document", async () => {
    // The largest events the schema allows: a 48-character ID, the largest revision and a note
    // of 1,024 newlines, which take two bytes each once escaped.
    const big = (count: number, noteLength = 1024) =>
      Array.from({ length: count }, (_, i) =>
        note(`n${String(i).padStart(2, "0")}${"x".repeat(45)}`, "\n".repeat(noteLength), { event_revision: Number.MAX_SAFE_INTEGER }),
      );
    const doc = (count: number, noteLength?: number) => ({ ...initial(big(count, noteLength)), rejections: markers(100) });

    // Twenty are a valid input under the cap, but the document with its five drafts is over it.
    const input = JSON.stringify(doc(20));
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(MAX_BYTES);
    expect(await invoke(["review"], input)).toEqual(failure("LIMIT", 1));

    // Nineteen of them, or twenty with slightly shorter notes, fit: the output is within the cap
    // and the next command accepts it.
    for (const smaller of [doc(19), doc(20, 1000)]) {
      const fits = await invoke(["review"], smaller);
      expect(fits.code).toBe(0);
      expect(Buffer.byteLength(fits.out)).toBeLessThanOrEqual(MAX_BYTES);
      expect((await invoke(["show"], fits.out)).code).toBe(0);
    }
  });

  test("learning expiry deletion and source changes invalidate drafts", async () => {
    const draftsAt = async (now: string) => eventIds(printed(await invoke(["review"], fixture(), now)));
    const both = ["check-dates", "short-answers"];

    // An event is eligible while recorded_at <= now < expires_at, to the millisecond.
    expect(await draftsAt("2026-10-12T11:59:59.999Z")).toEqual([]);
    expect(await draftsAt("2026-10-12T12:00:00.000Z")).toEqual(both);
    expect(await draftsAt("2026-11-12T11:59:59.999Z")).toEqual(both);
    expect(await draftsAt("2026-11-12T12:00:00.000Z")).toEqual([]);
    expect(await draftsAt("2026-11-12T12:00:00.001Z")).toEqual([]);

    // A saved document is shown while its drafts are current, and is STALE from the expiry on.
    const reject = ["reject", LESSON_ID, "--expected-revision", "1"];
    expect((await invoke(["show"], REVIEWED, "2026-11-12T11:59:59.999Z")).out).toBe(SHOWN);
    for (const args of [["show"], reject]) {
      expect(await invoke(args, REVIEWED, "2026-11-12T12:00:00.000Z"), args[0]).toEqual(failure("STALE", 1));
    }

    // A document that was never reviewed has no digest to compare with.
    expect(await invoke(["show"], fixture())).toEqual(failure("STALE", 1));
    expect(await invoke(["reject", LESSON_ID, "--expected-revision", "0"], fixture())).toEqual(failure("STALE", 1));

    // A changed snapshot, a changed event or a deleted event: show and reject say STALE.
    const withSnapshot = JSON.parse(REVIEWED);
    withSnapshot.settings.revision = 4;
    const withEvent = JSON.parse(REVIEWED);
    withEvent.events[0] = { ...withEvent.events[0], event_revision: 2, text: "Check invoice dates twice." };
    const withTombstone = JSON.parse(REVIEWED);
    withTombstone.events[0] = { event_id: "check-dates", event_revision: 2, state: "deleted" };
    for (const changed of [withSnapshot, withEvent, withTombstone]) {
      for (const args of [["show"], reject]) expect(await invoke(args, changed), args[0]).toEqual(failure("STALE", 1));
    }

    // Review after the deletion: the old draft and every byte of the deleted note are gone.
    const regenerated = await invoke(["review"], withTombstone);
    expect(regenerated.out).not.toContain("Check invoice dates");
    expect(regenerated.out).not.toContain(LESSON_ID);
    expect(eventIds(printed(regenerated))).toEqual(["short-answers"]);
    expect(printed(regenerated).events[0]).toEqual({ event_id: "check-dates", event_revision: 2, state: "deleted" });
    expect(printed(regenerated).revision).toBe(2);

    // Review after the snapshot changed: the setting draft has a new ID bound to the new snapshot.
    const rebound = await invoke(["review"], withSnapshot);
    const newSettings = SETTINGS.replace(`"revision":3`, `"revision":4`);
    expect(printed(rebound).drafts[1].id).toBe(sha256(`{"event":${SETTING_EVENT},"settings":${newSettings}}`));
    expect(printed(rebound).drafts[1].effect.expected_settings_revision).toBe(4);
    expect(rebound.out).not.toContain(SETTING_ID);
  });

  test("learning a changed event is a new unverified proposal", async () => {
    // The setting draft was rejected. The user then records the correction again as revision 2.
    const doc = JSON.parse(REJECTED);
    doc.events[1] = { ...doc.events[1], event_revision: 2 };
    const got = printed(await invoke(["review"], doc));
    const again = got.drafts.find((d: any) => d.event_id === "short-answers");
    const changedEvent = SETTING_EVENT.replace(`"event_revision":1`, `"event_revision":2`);
    expect(again.id).toBe(sha256(`{"event":${changedEvent},"settings":${SETTINGS}}`));
    expect(again.id).not.toBe(SETTING_ID);
    expect([again.status, again.authority, again.evaluation, again.event_revision]).toEqual([
      "DRAFT",
      "user-supplied-unverified",
      "not-run",
      2,
    ]);
    // The earlier rejection is still recorded and still names only the earlier proposal.
    expect(got.rejections).toEqual([{ id: SETTING_ID }]);
    expect(got.revision).toBe(3);
  });

  test("learning rejection filtering is exact", async () => {
    const rejected = await invoke(["reject", SETTING_ID, "--expected-revision", "1"], REVIEWED);
    expect(rejected.out).toBe(REJECTED);
    expect(printed(rejected).revision).toBe(EXPECTED.revision_after_reject);
    expect(eventIds(printed(rejected))).toEqual(EXPECTED.draft_event_ids_after_reject);
    // The marker is the proposal ID alone: no note, no reason.
    expect(printed(rejected).rejections).toEqual([{ id: SETTING_ID }]);

    // Review with the marker does not bring the proposal back, however often it runs.
    const replay = await invoke(["review"], rejected.out);
    expect(replay.out).toBe(REJECTED);
    expect((await invoke(["review"], replay.out)).out).toBe(REJECTED);

    // Rejecting it a second time is NOT_FOUND, not a silent success.
    expect(await invoke(["reject", SETTING_ID, "--expected-revision", "2"], rejected.out)).toEqual(failure("NOT_FOUND", 1));
  });

  test("learning review is repeatable and refuses a revision it cannot raise", async () => {
    // The same input on the same clock gives the same bytes; a reviewed document keeps its revision.
    const first = await invoke(["review"], INPUT);
    expect(first.out).toBe(REVIEWED);
    expect((await invoke(["review"], INPUT)).out).toBe(first.out);
    expect((await invoke(["review"], first.out)).out).toBe(first.out);

    const top = Number.MAX_SAFE_INTEGER;
    expect(await invoke(["review"], { ...fixture(), revision: top })).toEqual(failure("LIMIT", 1));
    const saved = { ...JSON.parse(REVIEWED), revision: top };
    expect(await invoke(["reject", LESSON_ID, "--expected-revision", String(top)], saved)).toEqual(failure("LIMIT", 1));
    // Nothing to change means nothing to raise: the same document comes back.
    expect(printed(await invoke(["review"], saved)).revision).toBe(top);
  });

  test("learning order and digest do not depend on locale", async () => {
    // Six notes. In code-unit order "-" < "0" < "b" and "ch" < "d" < "h"; some locales sort
    // "ch" after "h", and a locale-aware comparison is free to order the others differently.
    const ids = ["h", "ab", "d", "a0", "ch", "a-b"];
    const sorted = ["a-b", "a0", "ab", "ch", "d", "h"];
    const doc = initial(ids.map((id) => note(id, `Note ${id}`)));
    const literalEvents = sorted.map((id) => noteText(id, `Note ${id}`)).join(",");

    // A hostile locale comparison: it reverses the order and counts its calls.
    const original = String.prototype.localeCompare;
    let calls = 0;
    String.prototype.localeCompare = function (this: string, other: string) {
      calls++;
      return this < other ? 1 : this > other ? -1 : 0;
    };
    let got;
    try {
      got = printed(await invoke(["review"], doc));
    } finally {
      String.prototype.localeCompare = original;
    }
    expect(got.events.map((e: any) => e.event_id)).toEqual(sorted);
    expect(eventIds(got)).toEqual(sorted.slice(0, 5));
    expect(got.omitted_event_ids).toEqual(["h"]);
    expect(got.source_digest).toBe(sha256(`{"events":[${literalEvents}],"settings":null}`));
    expect(calls).toBe(0);
  });
});
