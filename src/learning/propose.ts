// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Draft proposals from explicit records: which events are eligible, which settings conflict,
 * the draft IDs, the five-draft cut and rejection.
 *
 * Everything here is a pure function of the document and the clock. Drafts are always
 * recomputed from the events; the draft text a document carries is never used as a rule.
 * Nothing is applied: there is no accept step, no store and no settings write.
 */
import {
  type ActiveEvent,
  canonical,
  digest,
  type Draft,
  type Event,
  type LearningDocumentV1,
  LearningError,
  MAX_DRAFTS,
  MAX_REJECTIONS,
  type Rejection,
  type SettingEvent,
} from "./schema.js";

export interface Derived {
  events: Event[];
  rejections: Rejection[];
  source_digest: string;
  drafts: Draft[];
  omitted_event_ids: string[];
}

/** Fields every draft carries, whatever the event says. */
const DRAFT_LABELS = { status: "DRAFT", authority: "user-supplied-unverified", evaluation: "not-run" } as const;

/** Order by UTF-16 code units: the same on every machine, whatever its locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One event per ID, sorted by ID. The same ID twice with the same content counts once; the
 * same ID with different content or revision is a conflict, never a newest-wins choice.
 */
function uniqueEvents(events: Event[]): Event[] {
  const byId = new Map<string, Event>();
  for (const e of events) {
    const seen = byId.get(e.event_id);
    if (seen && canonical(seen) !== canonical(e)) throw new LearningError("CONFLICT");
    byId.set(e.event_id, e);
  }
  return [...byId.values()].sort((a, b) => byCodeUnit(a.event_id, b.event_id));
}

function uniqueRejections(rejections: Rejection[]): Rejection[] {
  return [...new Set(rejections.map((r) => r.id))].sort(byCodeUnit).map((id) => ({ id }));
}

/** Active, already recorded and not yet expired: `recorded_at <= now < expires_at`. */
function isEligible(e: Event, nowMs: number): e is ActiveEvent {
  return e.state === "active" && Date.parse(e.recorded_at) <= nowMs && nowMs < Date.parse(e.expires_at);
}

/** Setting keys for which the eligible corrections ask for more than one value. */
function conflictingKeys(active: ActiveEvent[]): Set<string> {
  const values = new Map<string, Set<string>>();
  for (const e of active) {
    if (e.kind !== "setting-correction") continue;
    const seen = values.get(e.key) ?? new Set<string>();
    seen.add(e.value);
    values.set(e.key, seen);
  }
  return new Set([...values].filter(([, seen]) => seen.size > 1).map(([key]) => key));
}

function draftOf(e: ActiveEvent, id: string, kind: Draft["kind"], effect: Draft["effect"], conflict: boolean): Draft {
  return {
    id,
    ...DRAFT_LABELS,
    event_id: e.event_id,
    event_revision: e.event_revision,
    kind,
    effect,
    expires_at: e.expires_at,
    conflict,
  };
}

/**
 * A setting draft, or null when the snapshot already has the value and nothing conflicts.
 * With a snapshot the before value is known, and null means the key is unset there; without
 * one the before value and the settings revision are unknown and are not guessed.
 */
function settingDraft(e: SettingEvent, id: string, doc: LearningDocumentV1, conflict: boolean): Draft | null {
  const before = doc.settings?.values[e.key] ?? null;
  if (!conflict && before === e.value) return null;
  const effect = {
    key: e.key,
    before,
    before_known: doc.settings !== null,
    expected_settings_revision: doc.settings?.revision ?? null,
    after: e.value,
  };
  return draftOf(e, id, "setting", effect, conflict);
}

/** Recompute every derived field of the document from its events, snapshot and rejections. */
export function derive(doc: LearningDocumentV1, now: Date): Derived {
  const events = uniqueEvents(doc.events);
  const rejections = uniqueRejections(doc.rejections);
  const nowMs = now.getTime();
  const active = events.filter((e): e is ActiveEvent => isEligible(e, nowMs));
  // Conflicts are decided over all eligible corrections, before any of them is left out as
  // rejected or already satisfied, so an agreeing correction cannot hide an opposite one.
  const conflicts = conflictingKeys(active);
  const rejected = new Set(rejections.map((r) => r.id));
  const eligible: Draft[] = [];
  for (const e of active) {
    // The ID binds the event and, for a setting, the exact snapshot it was compared with.
    const id = digest({ event: e, settings: e.kind === "lesson-note" ? null : doc.settings });
    if (rejected.has(id)) continue;
    if (e.kind === "lesson-note") {
      eligible.push(draftOf(e, id, "lesson", { quoted_note: e.text }, false));
      continue;
    }
    const draft = settingDraft(e, id, doc, conflicts.has(e.key));
    if (draft) eligible.push(draft);
  }
  return {
    events,
    rejections,
    source_digest: digest({ settings: doc.settings, events }),
    drafts: eligible.slice(0, MAX_DRAFTS),
    omitted_event_ids: eligible.slice(MAX_DRAFTS).map((d) => d.event_id),
  };
}

/** The document without its revision, for "did anything change". */
function withoutRevision(doc: LearningDocumentV1): unknown {
  const { revision, ...rest } = doc;
  return rest;
}

/** The next document: derived fields regenerated; the revision goes up once if anything changed. */
export function review(doc: LearningDocumentV1, now: Date): LearningDocumentV1 {
  const next = { ...doc, ...derive(doc, now) };
  if (canonical(withoutRevision(next)) !== canonical(withoutRevision(doc))) {
    if (doc.revision === Number.MAX_SAFE_INTEGER) throw new LearningError("LIMIT");
    next.revision++;
  }
  return next;
}

/** Throws STALE unless the stored digest, drafts and omissions are what the events give now. */
export function assertCurrent(doc: LearningDocumentV1, now: Date): Derived {
  const current = derive(doc, now);
  if (doc.source_digest === null || doc.source_digest !== current.source_digest) throw new LearningError("STALE");
  if (canonical(doc.drafts) !== canonical(current.drafts)) throw new LearningError("STALE");
  if (canonical(doc.omitted_event_ids) !== canonical(current.omitted_event_ids)) throw new LearningError("STALE");
  return current;
}

/** Remove one current draft: keep its ID as a marker and raise the revision once. */
export function reject(doc: LearningDocumentV1, id: string, expected: number, now: Date): LearningDocumentV1 {
  if (doc.revision !== expected) throw new LearningError("CONFLICT");
  assertCurrent(doc, now);
  if (!doc.drafts.some((d) => d.id === id)) throw new LearningError("NOT_FOUND");
  if (doc.revision === Number.MAX_SAFE_INTEGER) throw new LearningError("LIMIT");
  const marked = { ...doc, rejections: [...doc.rejections, { id }] };
  const next = derive(marked, now);
  // One marker more than the cap would be a document the next command refuses.
  if (next.rejections.length > MAX_REJECTIONS) throw new LearningError("LIMIT");
  return { ...marked, ...next, revision: doc.revision + 1 };
}
