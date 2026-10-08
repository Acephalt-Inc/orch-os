// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Addressed agent-to-agent messages (new in v2).
 *
 * Store: one append-only JSON-lines file ([messages] path). Each line is one message:
 *   {"seq": 7, "id": "<uuid>", "ts": "<iso>", "from": "lead", "to": "w1", "kind": "QUESTION",
 *    "reply_to": null, "body": "..."}
 * `seq` is assigned under the file lock (highest seq + 1), so it is unique and increasing. Every
 * field is JSON-encoded, so a body can never forge another message, a header or an id.
 *
 * Addressing: `to` is one reader name, or "*" for everyone. A reader sees messages sent to its
 * name or to "*", except its own broadcasts. Names compare case-insensitively (see nameKey).
 *
 * Cursor + ack: each reader has cursors/<reader>.json = {"reader", "acked_through", "acked"}.
 * `acked_through` is a watermark (every message for this reader up to that seq is acked);
 * `acked` holds acked ids above it. Pending = addressed to the reader and not acked. Acks are
 * idempotent; a reader can ack only messages addressed to it. Reading never acks by itself.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { withLock } from "./lock.js";
import { stamp } from "./mailbox.js";
import { dumps } from "./pyjson.js";
import { assertWriteOwnership, atomicWrite, isPlainObject, validName } from "./util.js";

export const KINDS = ["QUESTION", "ANSWER", "DONE", "BLOCKED"] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_BODY = 64 * 1024;

export interface Message {
  seq: number;
  id: string;
  ts: string;
  from: string;
  to: string;
  kind: Kind;
  reply_to: string | null;
  body: string;
}

export class MessageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MessageError";
  }
}

interface Cursor {
  reader: string;
  acked_through: number;
  acked: string[];
}

export class Messages {
  readonly lock: string;
  constructor(readonly path: string, readonly cursorDir: string) {
    this.lock = path + ".lock.d";
  }

  /** Every well-formed message in seq order. Malformed lines are skipped (and counted). */
  all(): Message[] {
    if (!existsSync(this.path)) return [];
    const out: Message[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (isPlainObject(m) && Number.isInteger(m.seq) && typeof m.id === "string" && typeof m.body === "string" &&
          (KINDS as readonly string[]).includes(m.kind) && typeof m.to === "string" && typeof m.from === "string") out.push(m as Message);
      } catch { /* a torn or foreign line is ignored, never trusted */ }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  get(id: string): Message | undefined {
    return this.all().find((m) => m.id === id);
  }

  send(from: string, to: string, kind: string, body: string, replyTo?: string | null, now?: Date): Message {
    const k = kind.toUpperCase();
    if (!(KINDS as readonly string[]).includes(k)) throw new MessageError(`unknown kind '${kind}'; use one of ${KINDS.join(", ")}`);
    if (!validName(from)) throw new MessageError(`bad sender '${from}': use letters, digits, . @ _ -`);
    if (to !== "*" && !validName(to)) throw new MessageError(`bad recipient '${to}': a name, or * for everyone`);
    if (!body.trim()) throw new MessageError("empty message");
    if (Buffer.byteLength(body) > MAX_BODY) throw new MessageError(`message too long (limit ${MAX_BODY} bytes)`);
    if (k === "ANSWER" && !replyTo) throw new MessageError("an ANSWER needs --reply-to <QUESTION id>");
    mkdirSync(dirname(this.path), { recursive: true });
    return withLock(this.lock, () => {
      if (replyTo) {
        const q = this.get(replyTo);
        if (!q) throw new MessageError(`--reply-to ${replyTo}: no such message`);
        if (k === "ANSWER" && q.kind !== "QUESTION") throw new MessageError(`--reply-to ${replyTo} is a ${q.kind}, not a QUESTION`);
      }
      // the highest valid seq, read under the lock (a foreign or torn last line cannot reset it)
      const seq = this.all().reduce((mx, m) => Math.max(mx, m.seq), 0) + 1;
      const msg: Message = { seq, id: randomUUID(), ts: stamp(now), from, to, kind: k as Kind, reply_to: replyTo ?? null, body: body.replace(/\s+$/, "") };
      // one write() of one line: readers never see half a message from a live writer
      // if an earlier writer died mid-line, start on a fresh line so this message stays readable
      const sep = endsWithNewline(this.path) ? "" : "\n";
      assertWriteOwnership();
      appendFileSync(this.path, sep + dumps(msg) + "\n");
      return msg;
    });
  }

  private cursorPath(reader: string): string {
    return `${this.cursorDir}/${nameKey(reader)}.json`;
  }

  cursor(reader: string): Cursor {
    if (!validName(reader)) throw new MessageError(`bad reader '${reader}': use letters, digits, . @ _ -`);
    try {
      const c = JSON.parse(readFileSync(this.cursorPath(reader), "utf8"));
      if (isPlainObject(c) && Number.isInteger(c.acked_through) && Array.isArray(c.acked)) {
        return { reader, acked_through: c.acked_through, acked: c.acked.filter((x: unknown) => typeof x === "string") };
      }
    } catch { /* no cursor yet */ }
    return { reader, acked_through: 0, acked: [] };
  }

  /** Messages addressed to reader (its name or "*", not its own broadcasts), in seq order. */
  inbox(reader: string): Message[] {
    const me = nameKey(reader);
    return this.all().filter((m) => nameKey(m.to) === me || (m.to === "*" && nameKey(m.from) !== me));
  }

  pending(reader: string): Message[] {
    const c = this.cursor(reader);
    const acked = new Set(c.acked);
    return this.inbox(reader).filter((m) => m.seq > c.acked_through && !acked.has(m.id));
  }

  /** Ack ids (or every pending message when ids is "all"). Returns the ids newly acked. */
  ack(reader: string, ids: string[] | "all"): string[] {
    this.cursor(reader); // validates the name
    mkdirSync(this.cursorDir, { recursive: true });
    return withLock(this.cursorPath(reader) + ".lock.d", () => {
      const c = this.cursor(reader);
      const box = this.inbox(reader);
      const byId = new Map(box.map((m) => [m.id, m]));
      const acked = new Set(c.acked);
      const isAcked = (m: Message) => m.seq <= c.acked_through || acked.has(m.id);
      const want = ids === "all" ? box.filter((m) => !isAcked(m)).map((m) => m.id) : ids;
      const fresh: string[] = [];
      for (const id of want) {
        const m = byId.get(id);
        if (!m) throw new MessageError(`no message ${id} addressed to ${reader}`);
        if (!isAcked(m)) {
          acked.add(id);
          fresh.push(id);
        }
      }
      // advance the watermark over the leading run of acked messages, then drop ids below it
      let through = c.acked_through;
      for (const m of box) {
        if (m.seq <= through) continue;
        if (!acked.has(m.id)) break;
        through = m.seq;
      }
      const keep = [...acked].filter((id) => (byId.get(id)?.seq ?? 0) > through).sort();
      const next: Cursor = { reader, acked_through: through, acked: keep };
      atomicWrite(this.cursorPath(reader), dumps(next));
      return fresh;
    });
  }
}

/**
 * C0/C1 control characters (tab and newline kept), line/paragraph separators and bidi
 * overrides shown as \xNN / \uNNNN, so text can neither move the cursor nor reorder a line.
 */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (c) => {
    const h = c.charCodeAt(0).toString(16);
    return c.charCodeAt(0) > 0xff ? `\\u${h.padStart(4, "0")}` : `\\x${h.padStart(2, "0")}`;
  });
}

/**
 * Human-readable form. "\r\n" becomes "\n"; any other control or line-separator character is
 * shown as \xNN / \uNNNN, so it cannot move the cursor or start a line; then body lines that
 * start with "---" or "\" are escaped with "\". A body can never print a fake header.
 */
export function renderMessage(m: Message): string {
  const re = m.reply_to ? ` re=${m.reply_to}` : "";
  const body = visible(m.body.replace(/\r\n/g, "\n")).split("\n").map((l) => (l.startsWith("---") || l.startsWith("\\") ? "\\" + l : l)).join("\n");
  return `--- #${m.seq} ${m.kind} from=${m.from} to=${m.to}${re} id=${m.id} ${m.ts}\n${body}`;
}

/**
 * Names compare case-insensitively (after Unicode NFC), because cursor files live on file
 * systems that may be case-insensitive: "Lead" and "lead" are one reader with one cursor.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function endsWithNewline(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true; // no file yet
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
