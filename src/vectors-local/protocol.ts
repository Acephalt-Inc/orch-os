import { decodeStrictJson } from "../private-store/json.js";

const MAX_INFO = 8 * 1024;
const MAX_EMBED = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256;
}

export function validateInfo(bytes: Uint8Array): void {
  const value = decodeStrictJson(bytes, { maxInputBytes: MAX_INFO, maxStringBytes: 256 });
  if (!object(value) || value.version !== "1.9.4" || value.max_input_length !== 512) throw new Error("refused");
  if (typeof value.auto_truncate !== "boolean") throw new Error("refused");
  if (!boundedString(value.model_id) || !boundedString(value.served_model_name)) throw new Error("refused");
  if (!object(value.model_type) || !object(value.model_type.embedding)) throw new Error("refused");
  if (!boundedString(value.model_type.embedding.pooling)) throw new Error("refused");
}

/** Only a single numeric vector is accepted. This intentionally does not decode general JSON. */
export function observedDimension(bytes: Uint8Array): number {
  if (bytes.byteLength > MAX_EMBED) throw new Error("refused");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let index = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const whitespace = (): void => {
    while (index < text.length && /[ \t\r\n]/.test(text[index])) index++;
  };
  const take = (character: string): void => {
    whitespace();
    if (text[index++] !== character) throw new Error("refused");
  };
  take("[");
  take("[");
  let count = 0;
  let nonzero = false;
  for (;;) {
    whitespace();
    number.lastIndex = index;
    const token = number.exec(text);
    if (!token) throw new Error("refused");
    index = number.lastIndex;
    const value = Number(token[0]);
    if (!Number.isFinite(value)) throw new Error("refused");
    nonzero ||= value !== 0;
    count++;
    if (count > 1536) throw new Error("refused");
    whitespace();
    if (text[index] === "]") break;
    take(",");
  }
  take("]");
  take("]");
  whitespace();
  if (index !== text.length || count === 0 || !nonzero) throw new Error("refused");
  return count;
}
