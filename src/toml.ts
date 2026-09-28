// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * A small TOML reader for config.toml (no dependency). Supported: comments, [table] and
 * [dotted.table] headers, bare/quoted/dotted keys, basic "..." and literal '...' strings,
 * integers (with _), floats, booleans, arrays (multi-line, trailing comma, comments) and
 * inline tables. Not supported, and reported as an error rather than guessed: multi-line
 * strings, dates/times, arrays of tables ([[x]]). Duplicate keys and tables are errors.
 */

export class TomlError extends Error {
  constructor(msg: string, line: number) {
    super(`${msg} (at line ${line})`);
    this.name = "TomlError";
  }
}

type Table = Record<string, any>;

const BARE_KEY = /^[A-Za-z0-9_-]+/;
/** Keys that would reach Object.prototype through a plain object. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class Parser {
  i = 0;
  line = 1;
  constructor(readonly s: string) {}

  err(msg: string): never {
    throw new TomlError(msg, this.line);
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  eof(): boolean {
    return this.i >= this.s.length;
  }

  skipWs(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }

  skipComment(): void {
    if (this.peek() === "#") {
      while (!this.eof() && this.peek() !== "\n") this.i++;
    }
  }

  /** whitespace, newlines and comments (inside arrays) */
  skipAll(): void {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (this.peek() === "\n") {
        this.i++;
        this.line++;
      } else if (this.peek() === "\r" && this.s[this.i + 1] === "\n") {
        this.i += 2;
        this.line++;
      } else return;
    }
  }

  endOfLine(): void {
    this.skipWs();
    this.skipComment();
    if (this.eof()) return;
    if (this.peek() === "\r" && this.s[this.i + 1] === "\n") this.i++;
    if (this.peek() !== "\n") this.err(`unexpected ${JSON.stringify(this.peek())}`);
    this.i++;
    this.line++;
  }

  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const m = BARE_KEY.exec(this.s.slice(this.i));
        if (!m) this.err("expected a key");
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.skipWs();
      if (this.peek() === ".") {
        this.i++;
        continue;
      }
      return parts;
    }
  }

  basicString(): string {
    if (this.s.startsWith('"""', this.i)) this.err("multi-line strings are not supported");
    this.i++;
    let out = "";
    for (;;) {
      if (this.eof()) this.err("unterminated string");
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === "\n") this.err("newline in string");
      if (c === "\\") {
        const e = this.s[this.i++];
        const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e in map) out += map[e];
        else if (e === "u" || e === "U") {
          const n = e === "u" ? 4 : 8;
          const hex = this.s.slice(this.i, this.i + n);
          if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) this.err("bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          this.i += n;
        } else this.err(`bad escape \\${e ?? ""}`);
      } else out += c;
    }
  }

  literalString(): string {
    if (this.s.startsWith("'''", this.i)) this.err("multi-line strings are not supported");
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf("\n", this.i);
    if (end < 0 || (nl >= 0 && nl < end)) this.err("unterminated string");
    const v = this.s.slice(this.i, end);
    this.i = end + 1;
    return v;
  }

  value(): any {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i));
    if (!m) this.err("expected a value");
    const tok = m[0];
    this.i += tok.length;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(tok)) return parseInt(tok.replace(/_/g, ""), 10);
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 16);
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(tok)) return parseFloat(tok.replace(/_/g, ""));
    if (/^[+-]?(inf|nan)$/.test(tok)) return tok.endsWith("inf") ? (tok.startsWith("-") ? -Infinity : Infinity) : NaN;
    if (/^\d{4}-\d{2}-\d{2}/.test(tok) || /^\d{2}:\d{2}/.test(tok)) this.err("dates and times are not supported");
    this.err(`invalid value ${JSON.stringify(tok)}`);
  }

  array(): any[] {
    this.i++;
    const out: any[] = [];
    for (;;) {
      this.skipAll();
      if (this.eof()) this.err("unterminated array");
      if (this.peek() === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.skipAll();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() === "]") {
        this.i++;
        return out;
      }
      this.err("expected , or ] in array");
    }
  }

  inlineTable(): Table {
    this.i++;
    const out: Table = {};
    this.skipWs();
    if (this.peek() === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      const k = this.key();
      this.skipWs();
      if (this.peek() !== "=") this.err("expected = in inline table");
      this.i++;
      this.assign(out, k, this.value());
      this.skipWs();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      this.err("expected , or } in inline table");
    }
  }

  assign(t: Table, key: string[], v: any): void {
    let cur = t;
    for (const k of key) if (UNSAFE_KEYS.has(k)) this.err(`key ${k} is not allowed`);
    for (const k of key.slice(0, -1)) {
      if (!Object.hasOwn(cur, k)) cur[k] = {};
      else if (typeof cur[k] !== "object" || cur[k] === null || Array.isArray(cur[k])) this.err(`key ${k} is not a table`);
      cur = cur[k];
    }
    const last = key[key.length - 1];
    if (Object.prototype.hasOwnProperty.call(cur, last)) this.err(`duplicate key ${key.join(".")}`);
    cur[last] = v;
  }

  parse(): Table {
    const root: Table = {};
    const defined = new Set<string>();
    let cur = root;
    for (;;) {
      this.skipAll();
      if (this.eof()) return root;
      if (this.peek() === "[") {
        if (this.s[this.i + 1] === "[") this.err("arrays of tables are not supported");
        this.i++;
        const k = this.key();
        if (this.peek() !== "]") this.err("expected ] after table name");
        this.i++;
        const id = JSON.stringify(k);
        if (defined.has(id)) this.err(`duplicate table [${k.join(".")}]`);
        defined.add(id);
        cur = root;
        for (const part of k) {
          if (UNSAFE_KEYS.has(part)) this.err(`key ${part} is not allowed`);
          if (!Object.hasOwn(cur, part)) cur[part] = {};
          else if (typeof cur[part] !== "object" || Array.isArray(cur[part])) this.err(`${part} is not a table`);
          cur = cur[part];
        }
        this.endOfLine();
        continue;
      }
      const k = this.key();
      this.skipWs();
      if (this.peek() !== "=") this.err("expected = after key");
      this.i++;
      this.assign(cur, k, this.value());
      this.endOfLine();
    }
  }
}

export function parseToml(text: string): Record<string, any> {
  return new Parser(text).parse();
}
