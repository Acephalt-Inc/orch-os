// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0

export interface JsonLimits {
  maxInputBytes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringBytes?: number;
}

/** Only trusted importing code supplies functions; input bytes never select a seam. */
export interface JsonSeam {
  decoded?: (value: unknown) => void;
}

export class StrictJsonError extends Error {
  constructor(readonly code: "BAD_INPUT" | "TOO_LARGE") {
    super(code === "BAD_INPUT" ? "invalid strict JSON input" : "strict JSON input exceeds limits");
    this.name = "StrictJsonError";
  }
}

/** Compile-only scaffold: no input has been accepted yet. */
export function decodeStrictJson(_bytes: Uint8Array, _limits: JsonLimits = {}, _seam: JsonSeam = {}): unknown {
  throw new StrictJsonError("BAD_INPUT");
}
