// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { join } from "node:path";
import { type CmdSpec, HelpRequested, parse } from "../args.js";
import * as C from "../config.js";
import { Lease } from "../lease.js";
import { Messages } from "../messages.js";
import { LeadLoop } from "./runtime.js";

export function runtimeSpecs(): CmdSpec[] {
  const common = [
    { dest: "session", flags: ["--session"], kind: "str" as const, help: "required unique session name" },
    { dest: "seconds", flags: ["--seconds"], kind: "int" as const, help: "lease duration in seconds" },
  ];
  return [
    { name: "boot", help: "acquire or renew the lead lease and save a restart receipt", opts: common },
    { name: "tick", help: "inspect one approved batch of lead events and save the cursor", opts: [...common,
      { dest: "expected_epoch", flags: ["--expected-epoch"], kind: "int", help: "required current lease epoch" },
      { dest: "tick", flags: ["--tick"], kind: "int", help: "required increasing tick number" },
      { dest: "approved", flags: ["--approved"], kind: "bool", help: "approve this fixed event-inspection tick" },
    ] },
  ];
}

export function runLeadRuntime(argv: string[], io: { out(s: string): void; err(s: string): void }): number {
  try {
    const { args, cmd } = parse({ name: "lead", help: "lead loop", sub: runtimeSpecs() }, argv, ["orch", "lead"]);
    // Validate authorization and usage before loading config or creating any locks/files.
    if (!args.session || (cmd.name === "tick" && (!args.approved || !args.expected_epoch || !args.tick))) {
      throw new Error("--session is required; tick also requires --approved, --expected-epoch and --tick");
    }
    const cfg = C.loadOrDefault(), l = cfg.lease ?? {}, m = cfg.messages ?? {};
    const lease = new Lease(C.expand(l.path ?? join(C.orchHome(), "lease.json")),
      C.configNumber(l.default_seconds, 3600, "[lease] default_seconds", 1),
      C.configNumber(l.min_seconds, 60, "[lease] min_seconds", 1));
    const box = new Messages(C.expand(m.path ?? join(C.orchHome(), "messages.jsonl")),
      C.expand(m.cursors ?? join(C.orchHome(), "cursors")));
    const [code, result] = new LeadLoop(lease, box).run(cmd.name as "boot" | "tick", {
      session: args.session, seconds: args.seconds ?? undefined, expectedEpoch: args.expected_epoch,
      tick: args.tick, approved: args.approved,
    });
    io.out(JSON.stringify(result) + "\n");
    return code;
  } catch (e: any) {
    if (e instanceof HelpRequested) { io.out(e.text + "\n"); return 0; }
    io.err("orch lead: " + JSON.stringify(e.message ?? "runtime unavailable") + "\n");
    return 2;
  }
}
