// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
export type ErrorCode = "BAD_INPUT" | "BAD_BINDING" | "UNSAFE_PATH" | "PRIVACY_UNAVAILABLE" | "TOO_LARGE" | "DEADLINE" | "IO_UNAVAILABLE"
  | "CORRUPT_STATE" | "CONFLICT" | "STALE" | "LOCK_HELD" | "RECOVERY_REQUIRED" | "WRITE_OUTCOME_UNKNOWN" | "CLOCK_ROLLBACK";
export class PrivateStoreError extends Error {
  constructor(readonly code: ErrorCode) {
    super("private storage request refused");
    this.name = "PrivateStoreError";
  }
}
export function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
export async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PrivateStoreError) throw error;
    throw new PrivateStoreError(["ELOOP", "ENOTDIR", "EISDIR"].includes(errno(error) ?? "") ? "UNSAFE_PATH" : "IO_UNAVAILABLE");
  }
}
