// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
export class PrivateStoreError extends Error {
  readonly code = "IO_UNAVAILABLE";
  constructor() {
    super("private storage is unavailable");
    this.name = "PrivateStoreError";
  }
}
