// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = (...args) => {
  const error = new Error("synthetic EIO output failure");
  error.code = "EIO";
  process.stdout.emit("error", error);
  return originalWrite(...args);
};
