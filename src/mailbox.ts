// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Shared mailbox: one Markdown file, one section per role, lock-serialized posts.
 *
 * Each entry gets a generated timestamp header and a hidden id comment, and is inserted at the
 * top of its section while an exclusive lock is held. The file is re-read under the lock, so
 * concurrent writers never lose an entry. The file layout is the one v1.1 wrote.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { withLock } from "./lock.js";
import { atomicWrite, NAME_RE } from "./util.js";

// Only "\n" ends a line (Python re.M semantics). The JS m flag would also split on "\r", U+2028 and U+2029,
// which a body could use to forge headers, so the anchors are written out instead. "\r\n" is
// read as "\n" (like Python text mode), so a file saved with CRLF line ends still parses.
const HEADER_RE = /(?<=^|\n)### (\S+) \(([\p{L}\p{N}_]+)(?:\/([\p{L}\p{N}_.@-]+))?\)(?=\n|$)/gu;
const ID_LINE = /(?<=^|\n)<!-- id: ([0-9a-f-]{36}) -->(?=\n|$)/;
const ID_LINES = /(?<=^|\n)<!-- id: [0-9a-f-]{36} -->(?=\n|$)/g;

export interface Entry {
  ts: string;
  section: string;
  author: string | null;
  id: string | null;
  body: string;
}

/**
 * Body lines that start with '#', '<!--' or '\' get a leading backslash, so a body can never
 * look like a section marker, an entry header or an id comment.
 */
export function escapeBody(text: string): string {
  return text.split("\n").map((l) => (l.startsWith("#") || l.startsWith("<!--") || l.startsWith("\\") ? "\\" + l : l)).join("\n");
}

export function unescapeBody(text: string): string {
  return text.split("\n").map((l) => (l.startsWith("\\") ? l.slice(1) : l)).join("\n");
}

export function marker(section: string): string {
  return `## ${section}\n`;
}

/** `%Y-%m-%dT%H:%M:%S.%f%z` in local time, as v1.1 wrote it. */
let lastMicros = 0;

/** Microseconds since the epoch, strictly increasing within this process (like v1.1's %f). */
function nowMicros(): number {
  let us = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  if (us <= lastMicros) us = lastMicros + 1;
  lastMicros = us;
  return us;
}

export function stamp(d?: Date | null): string {
  const us = d ? d.getTime() * 1000 : nowMicros();
  const t = new Date(Math.floor(us / 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}` +
    `.${p(us % 1000000, 6)}${sign}${p(Math.floor(a / 60))}${p(a % 60)}`;
}

/** Epoch seconds of an ISO-8601 timestamp (Python `fromisoformat` subset), or null if unreadable. */
export function isoToEpoch(ts: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?)?$/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", tz] = m;
  const ms = frac ? Number((frac + "000000").slice(0, 6)) / 1000 : 0;
  const nums = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  if (nums[1] > 11 || nums[2] < 1 || nums[2] > 31 || nums[3] > 23 || nums[4] > 59 || nums[5] > 59) return null;
  let t: number;
  if (tz === undefined) {
    t = new Date(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]).getTime() + ms;
  } else {
    t = Date.UTC(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]) + ms;
    if (tz !== "Z") {
      const t2 = tz.replace(/:/g, "");
      const sign = t2[0] === "-" ? -1 : 1;
      const off = Number(t2.slice(1, 3)) * 3600 + Number(t2.slice(3, 5) || "0") * 60 + Number(t2.slice(5, 7) || "0");
      t -= sign * off * 1000;
    }
  }
  return t / 1000;
}

export class Mailbox {
  readonly sections: string[];
  readonly lock: string;
  constructor(readonly path: string, sections: string[]) {
    this.sections = sections.map((s) => String(s).toUpperCase());
    this.lock = path + ".lock.d";
  }

  skeleton(): string {
    const body = "# Mailbox\n\nWrite with `orch mailbox post`; entries are never edited in place.\n\n";
    return body + this.sections.map((s) => marker(s)).join("\n");
  }

  post(section: string, text: string, author?: string | null, now?: Date): string {
    section = section.toUpperCase();
    if (!this.sections.includes(section)) {
      throw new RangeError(`unknown section '${section}'; configured: ${this.sections.join(", ")}`);
    }
    if (!text.trim()) throw new RangeError("empty entry");
    if (author !== undefined && author !== null && !NAME_RE.test(author)) {
      throw new RangeError(`bad author '${author}': use letters, digits, . @ _ -`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const eid = randomUUID();
    const who = author ? `${section}/${author}` : section;
    const entry = `### ${stamp(now)} (${who})\n${escapeBody(text.trimEnd())}\n<!-- id: ${eid} -->\n\n`;
    withLock(this.lock, () => {
      let cur = existsSync(this.path) ? readFileSync(this.path, "utf8").replace(/\r\n/g, "\n") : this.skeleton();
      const m = marker(section);
      let at = ("\n" + cur).indexOf("\n" + m); // markers only count at the start of a line
      if (at < 0) {
        cur = cur.replace(/\n+$/, "") + "\n\n" + m;
        at = ("\n" + cur).indexOf("\n" + m);
      }
      const i = at + m.length;
      atomicWrite(this.path, cur.slice(0, i) + entry + cur.slice(i));
    });
    return eid;
  }

  entries(): Entry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8").replace(/\r\n/g, "\n");
    const heads = [...text.matchAll(HEADER_RE)];
    return heads.map((h, k) => {
      const hEnd = h.index! + h[0].length;
      const end = k + 1 < heads.length ? heads[k + 1].index! : text.length;
      let chunk = text.slice(hEnd, end);
      const sec = /(?<=^|\n)## /.exec(chunk);
      if (sec) chunk = chunk.slice(0, sec.index);
      const idm = ID_LINE.exec(chunk);
      const body = unescapeBody(chunk.replace(ID_LINES, "").trim());
      return { ts: h[1], section: h[2], author: h[3] ?? null, id: idm ? idm[1] : null, body };
    });
  }

  read(n = 10, section?: string | null): Entry[] {
    let es = this.entries();
    if (section) es = es.filter((e) => e.section === section.toUpperCase());
    const key = (e: Entry) => isoToEpoch(e.ts) ?? 0;
    // file order is newest-first inside a section, so ties sort by reverse file position
    const order = es.map((_, i) => i).sort((a, b) => key(es[a]) - key(es[b]) || b - a);
    return order.map((i) => es[i]).slice(-n);
  }
}
