// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0

/** Return printable ASCII; JSON serialization then quotes the literal escape sequences. */
export function display(value: string): string {
  let output = "";
  for (const point of value) {
    const code = point.codePointAt(0)!;
    const bidi = code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    if (code < 0x20 || code >= 0x7f || bidi) {
      for (let index = 0; index < point.length; index++) {
        output += `\\u${point.charCodeAt(index).toString(16).padStart(4, "0")}`;
      }
    } else {
      output += point;
    }
  }
  return output;
}
