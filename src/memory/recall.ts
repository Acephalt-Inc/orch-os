// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import type { SnapshotContext } from "../private-store/snapshot.js";
import { display } from "./display.js";
import { canonical, hash, MemoryShapeError, type Fact, type Payload, type Scope } from "./schema.js";

const FORBIDDEN = /[\p{Cc}\p{Bidi_Control}]/u;
const HAN = /\p{Script=Han}/u;
const LETTER_NUMBER = /[\p{L}\p{N}]/u;
const WHITE_SPACE = /^\p{White_Space}*$/u;
const LIMIT = /^(?:[1-9]|1[0-9]|20)$/;
const MAX_OUTPUT = 16_384;
type Options = { query: string; allTerms: boolean; limit: number };
type Prepared = { normalized: string; terms: string[] };
type Field = { normalized: string; counts: Map<string, number>; length: number };
type Candidate = { fact: Fact; title: Field; assertion: Field; score: number };

export function parseRecall(argv: string[]): Options {
  if (argv[0] !== "recall" || argv[1] !== "--query" || argv[2] === undefined) throw new Error("usage");
  let index = 3;
  let allTerms = false;
  let limit = 8;
  if (argv[index] === "--all-terms") {
    allTerms = true;
    index++;
  }
  if (argv[index] === "--limit" && LIMIT.test(argv[index + 1] ?? "")) {
    limit = Number(argv[index + 1]);
    index += 2;
  }
  if (index !== argv.length) throw new Error("usage");
  return { query: argv[2], allTerms, limit };
}

function normalized(value: string): string { return value.normalize("NFKC").toLowerCase().normalize("NFKC"); }
function tokens(value: string, query: boolean): string[] {
  const output: string[] = [];
  let run: string[] = [];
  let kind: "han" | "word" | null = null;
  function flush(): void {
    if (kind === "word") output.push(`w:${run.join("")}`);
    if (kind === "han") {
      if (!query || run.length === 1) for (const point of run) output.push(`h1:${point}`);
      if (!query || run.length > 1) for (let index = 1; index < run.length; index++) {
        output.push(`h2:${run[index - 1]}${run[index]}`);
      }
    }
    run = [];
    kind = null;
  }
  for (const point of value) {
    const next = HAN.test(point) ? "han" : LETTER_NUMBER.test(point) ? "word" : null;
    if (next !== kind) flush();
    kind = next;
    if (next) run.push(point);
  }
  flush();
  return output;
}
export function prepareRecall(query: string): Prepared {
  if (!(query as string & { isWellFormed(): boolean }).isWellFormed()) throw new MemoryShapeError("INVALID");
  if (Buffer.byteLength(query) > 2048) throw new MemoryShapeError("LIMIT");
  if (FORBIDDEN.test(query) || WHITE_SPACE.test(query)) throw new MemoryShapeError("INVALID");
  const text = normalized(query);
  if (FORBIDDEN.test(text)) throw new MemoryShapeError("INVALID");
  const terms = [...new Set(tokens(text, true))];
  if (terms.length === 0) throw new MemoryShapeError("INVALID");
  if (terms.length > 64) throw new MemoryShapeError("LIMIT");
  return { normalized: text, terms };
}
function field(value: string): Field {
  const text = normalized(value);
  const found = tokens(text, false);
  const counts = new Map<string, number>();
  for (const token of found) counts.set(token, (counts.get(token) ?? 0) + 1);
  return { normalized: text, counts, length: found.length };
}
function bm25(tf: number, length: number, average: number): number {
  return tf === 0 ? 0 : tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / Math.max(1, average)));
}
function excerpt(value: string): { value: string; length: number; truncated: boolean } {
  let valuePrefix = "";
  let length = 0;
  for (const point of value) {
    const bytes = Buffer.byteLength(point);
    if (length + bytes > 1024) break;
    valuePrefix += point;
    length += bytes;
  }
  return { value: valuePrefix, length, truncated: length < Buffer.byteLength(value) };
}
function item(fact: Fact, score: number, generation: number, at: string): object {
  const source = fact.sources[0];
  const quote = excerpt(source.quote);
  return { assertion: display(fact.assertion), citation: { checkedAt: at, digest: fact.digest,
    fragment: { end: source.fragmentStart + quote.length, start: source.fragmentStart },
    generation, id: fact.id, revision: fact.revision, scopeId: hash(canonical(fact.scope)),
    sourceHash: source.sha256, sourceId: source.sourceId, sourceRevision: 1 },
  expiresAt: fact.time.expiresAt, id: fact.id, polarity: fact.polarity, quote: display(quote.value),
  quoteTruncated: quote.truncated, revision: fact.revision, score, state: fact.state, title: display(fact.title) };
}
function packet(generation: number, items: object[], total: number): object {
  const omitted = total - items.length;
  return { generation, items, omitted, partial: omitted > 0 };
}
function fits(value: object): boolean { return Buffer.byteLength(canonical(value)) + 1 <= MAX_OUTPUT; }

export function projectRecall(payload: Payload, context: SnapshotContext, at: string, expectedScope: Scope,
  prepared: Prepared, options: Options): object {
  const eligible = payload.facts.filter((fact) => fact.state === "active" && fact.time.expiresAt > at
    && canonical(fact.scope) === canonical(expectedScope));
  const fields = eligible.map((fact) => ({ fact, title: field(fact.title), assertion: field(fact.assertion), score: 0 }));
  const count = fields.length;
  if (count === 0) return packet(context.generation, [], 0);
  const titleAverage = fields.reduce((sum, row) => sum + row.title.length, 0) / count;
  const assertionAverage = fields.reduce((sum, row) => sum + row.assertion.length, 0) / count;
  const idf = new Map<string, number>();
  for (const term of prepared.terms) {
    const df = fields.filter((row) => row.title.counts.has(term) || row.assertion.counts.has(term)).length;
    idf.set(term, Math.log(1 + (count - df + 0.5) / (df + 0.5)));
  }
  const matched: Candidate[] = [];
  for (const row of fields) {
    let raw = 0;
    let matches = 0;
    for (const term of prepared.terms) {
      const titleTf = row.title.counts.get(term) ?? 0;
      const assertionTf = row.assertion.counts.get(term) ?? 0;
      if (titleTf || assertionTf) matches++;
      raw += idf.get(term)! * (3 * bm25(titleTf, row.title.length, titleAverage)
        + bm25(assertionTf, row.assertion.length, assertionAverage));
    }
    if (matches === 0 || options.allTerms && matches !== prepared.terms.length || !Number.isFinite(raw) || raw <= 0) continue;
    const phrase = prepared.terms.length >= 2 && (row.title.normalized.includes(prepared.normalized)
      || row.assertion.normalized.includes(prepared.normalized)) ? 0.1 : 0;
    row.score = Number((raw + phrase).toFixed(12));
    matched.push(row);
  }
  matched.sort((left, right) => right.score - left.score || (left.fact.id < right.fact.id ? -1 : left.fact.id > right.fact.id ? 1 : 0)
    || left.fact.revision - right.fact.revision);
  const selected: object[] = [];
  for (const row of matched) {
    if (selected.length >= options.limit) break;
    const fact = row.fact;
    if (!payload.facts.includes(fact) || fact.state !== "active" || fact.time.expiresAt <= at
      || canonical(fact.scope) !== canonical(expectedScope)) return { error: "UNAVAILABLE" };
    const next = [...selected, item(fact, row.score, context.generation, at)];
    if (!fits(packet(context.generation, next, matched.length))) break;
    selected.push(next.at(-1)!);
  }
  if (matched.length && selected.length === 0) return { error: "LIMIT" };
  return packet(context.generation, selected, matched.length);
}
