// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The synthetic corpus and the in-memory transport that serves it. No service is contacted.
 * The store answers like a scoped document service: it looks only at the documents of the asking
 * principal and collection, offers only current text that is not revoked, and reports the
 * present state of a citation when asked to recheck it.
 */
import { CitationRef, digest, QuestionId, Transport } from "./schema.js";

type Scope = { principal: string; collection: string };

type Doc = Scope & {
  topic: QuestionId;
  document_id: string;
  fragment: string;
  /** Oldest first: revision numbers start at 1 and the last entry is the current text. */
  revisions: string[];
  revoked: boolean;
};

const DEMO: Scope = { principal: "demo-reader", collection: "demo-company" };
const OTHER: Scope = { principal: "other-reader", collection: "other-company" };

/** A fresh copy each time, so one store's scenario changes never reach another. */
function corpus(): Doc[] {
  return [
    {
      ...OTHER, topic: "invoice-terms", document_id: "other-policy", fragment: "terms",
      revisions: ["Invoices are due in 999 days."], revoked: false,
    },
    {
      ...DEMO, topic: "invoice-terms", document_id: "revoked-policy", fragment: "notice",
      revisions: ["Revoked synthetic material."], revoked: true,
    },
    {
      ...DEMO, topic: "invoice-terms", document_id: "invoice-policy", fragment: "terms",
      revisions: ["Invoices are due in 30 days.", "Invoices are due in 45 days."], revoked: false,
    },
    {
      ...DEMO, topic: "approval-threshold", document_id: "approval-policy", fragment: "threshold",
      revisions: ["Approval is required above 500 synthetic units."], revoked: false,
    },
  ];
}

function currentText(d: Doc): string {
  return d.revisions[d.revisions.length - 1];
}

function currentRef(d: Doc): CitationRef {
  return {
    document_id: d.document_id,
    revision: d.revisions.length,
    fragment: d.fragment,
    sha256: digest(currentText(d)),
  };
}

function bytes(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}

export type DemoStore = {
  transport: Transport;
  /** Scenario controls for tests. No command-line argument reaches them. */
  revoke(documentId: string): void;
  replace(documentId: string, excerpt: string): void;
  remove(documentId: string): void;
};

export function createDemoStore(): DemoStore {
  let docs = corpus();
  // Scope first: a document of another principal or collection is never a candidate.
  const visible = (scope: Scope) => docs.filter((d) => {
    return d.principal === scope.principal && d.collection === scope.collection;
  });
  const transport: Transport = {
    async lookup(request) {
      const passages = visible(request)
        .filter((d) => d.topic === request.question_id && !d.revoked)
        .map((d) => ({ ...currentRef(d), state: "current", excerpt: currentText(d) }));
      return bytes({
        schema_version: 1,
        principal: request.principal,
        collection: request.collection,
        passages,
      });
    },
    async revalidate(scope, ref) {
      const d = visible(scope).find((x) => x.document_id === ref.document_id && x.fragment === ref.fragment);
      if (!d) throw new Error("unknown citation");
      return bytes({
        schema_version: 1,
        principal: scope.principal,
        collection: scope.collection,
        ...currentRef(d),
        state: d.revoked ? "revoked" : "current",
      });
    },
  };
  return {
    transport,
    revoke(documentId) {
      for (const d of docs) if (d.document_id === documentId) d.revoked = true;
    },
    replace(documentId, excerpt) {
      for (const d of docs) if (d.document_id === documentId) d.revisions.push(excerpt);
    },
    remove(documentId) {
      docs = docs.filter((d) => d.document_id !== documentId);
    },
  };
}

/** The transport of the direct entry: the built-in corpus with no scenario applied. */
export function createDemoTransport(): Transport {
  return createDemoStore().transport;
}
