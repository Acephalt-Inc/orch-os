// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * One knowledge query: lookup, validation, then revalidation of the returned citation before
 * anything is reported. The binding and the question texts are compiled in; nothing from the
 * environment, the working directory or any store takes part.
 */
import {
  Binding, canonicalTime, checkReply, CitationRef, decode, digest, ErrorCode, lookupReply, QuestionId, Refusal,
  Request, serializeOutput, Transport,
} from "./schema.js";

const DEADLINE_MS = 5000;

const binding: Binding = {
  connection: "demo",
  principal: "demo-reader",
  collection: "demo-company",
};

const questions: Record<QuestionId, string> = {
  "invoice-terms": "What are the synthetic invoice terms?",
  "approval-threshold": "What is the synthetic approval threshold?",
};

/** `output` is the success line without its newline. */
export type Result = { exit: 0; output: string } | { exit: 1; code: ErrorCode };

function inScope(reply: { principal: string; collection: string }): boolean {
  return reply.principal === binding.principal && reply.collection === binding.collection;
}

function sameRef(a: CitationRef, b: CitationRef): boolean {
  return a.document_id === b.document_id && a.revision === b.revision && a.fragment === b.fragment
    && a.sha256 === b.sha256;
}

/**
 * Start one transport call and wait for it until the deadline. When the deadline passes first
 * the wait ends as TIMEOUT and a reply that arrives later is dropped: the caller does not resume,
 * so no further transport call starts. A failed call is UNAVAILABLE whatever it threw.
 */
function call(signal: AbortSignal, start: () => Promise<Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Refusal("TIMEOUT")), { once: true });
    const pending = (async () => start())();
    pending.then(resolve, () => reject(new Refusal("UNAVAILABLE")));
  });
}

export async function query(questionId: QuestionId, transport: Transport, now: () => Date): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    return { exit: 0, output: await run(questionId, transport, now, controller.signal) };
  } catch (e) {
    // Anything that is not a refusal of ours (a failing clock, a defect) is reported as
    // unavailable, never by its own message.
    return { exit: 1, code: e instanceof Refusal ? e.code : "UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

async function run(questionId: QuestionId, transport: Transport, now: () => Date, signal: AbortSignal): Promise<string> {
  const request: Request = {
    schema_version: 1,
    ...binding,
    question_id: questionId,
    query: questions[questionId],
  };
  const reply = lookupReply(decode(await call(signal, () => transport.lookup(request, signal))));
  if (!inScope(reply)) throw new Refusal("DENIED");
  if (reply.passages.length === 0) throw new Refusal("UNAVAILABLE");
  const passage = reply.passages[0];
  if (digest(passage.excerpt) !== passage.sha256) throw new Refusal("INVALID_RESPONSE");
  const ref: CitationRef = {
    document_id: passage.document_id,
    revision: passage.revision,
    fragment: passage.fragment,
    sha256: passage.sha256,
  };
  const retrievedAt = canonicalTime(now());
  const check = checkReply(decode(await call(signal, () => transport.revalidate(binding, ref, signal))));
  if (!inScope(check)) throw new Refusal("DENIED");
  if (check.state !== "current" || !sameRef(check, ref)) throw new Refusal("STALE");
  return serializeOutput({
    status: "OK",
    mode: "synthetic",
    question_id: questionId,
    answer: passage.excerpt,
    citation: { ...ref, retrieved_at: retrievedAt, checked_at: canonicalTime(now()) },
  });
}
