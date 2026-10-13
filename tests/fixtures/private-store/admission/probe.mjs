// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { bindWorkspace, partitionPaths } from "../../../../dist/private-store/binding.js";
try {
  const binding = await bindWorkspace(process.argv[2], "memory-v1", performance.now() + 5_000);
  console.log(JSON.stringify({ kind: "bound", paths: partitionPaths(binding), frozen: Object.isFrozen(binding) }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
}
