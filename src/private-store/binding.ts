// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { lstat, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, sep } from "node:path";
import { guarded, PrivateStoreError } from "./errors.js";
import { Budget, gate, type TestSeam } from "./limits.js";
declare const brand: unique symbol;
export type Binding = Readonly<{ [brand]: true }>;
export type PartitionPaths = Readonly<{ directory: string; state: string; lock: string }>;
const bindings = new WeakSet<object>();
const locations = new WeakMap<object, PartitionPaths>();
const namespaces = new Set(["memory-v1", "knowledge-v1", "tasks-v1"]);
const remote = new Set([0x6969, 0x517b, 0xff534d42, 0x65735546]);
async function observe(input: string, rejectLinks: boolean, budget: Budget): Promise<void> {
  const absolute = isAbsolute(input) ? input : process.cwd() + sep + input;
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep)) {
    current = join(current, part);
    const info = await budget.io(() => (budget.seam.lstat ?? lstat)(current));
    if (rejectLinks && info.isSymbolicLink()) throw new PrivateStoreError("BAD_BINDING");
  }
}
export async function bindWorkspace(workspace: string, namespace: string, deadline: number, seam: TestSeam = {}): Promise<Binding> {
  return guarded(async () => {
    const budget = new Budget(deadline, seam);
    if (typeof workspace !== "string" || !workspace || workspace.includes("\0") || !namespaces.has(namespace)) {
      throw new PrivateStoreError("BAD_INPUT");
    }
    await observe(workspace, true, budget);
    const canonical = await budget.io(() => (seam.realpath ?? realpath)(workspace));
    if (!(await budget.io(() => (seam.lstat ?? lstat)(canonical))).isDirectory()) throw new PrivateStoreError("BAD_BINDING");
    await observe(homedir(), false, budget);
    const home = await budget.io(() => (seam.realpath ?? realpath)(homedir()));
    if ((seam.platform?.() ?? process.platform) === "linux"
      && remote.has(Number((await budget.io(() => (seam.statfs ?? statfs)(home))).type))) {
      throw new PrivateStoreError("PRIVACY_UNAVAILABLE");
    }
    const digest = createHash("sha256").update(canonical).digest("hex");
    const directory = join(home, ".orch-private", namespace, "personal", digest);
    const binding = Object.freeze({}) as Binding;
    bindings.add(binding);
    locations.set(binding, Object.freeze({ directory, state: join(directory, "state.json"), lock: join(directory, ".lock") }));
    return binding;
  });
}
export function partitionPaths(binding: Binding, seam: TestSeam = {}): PartitionPaths {
  gate(seam);
  if (!binding || typeof binding !== "object" || !bindings.has(binding)) throw new PrivateStoreError("BAD_BINDING");
  return locations.get(binding)!;
}
