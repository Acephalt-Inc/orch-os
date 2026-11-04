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
    { name: "dispatch", help: "reserve and launch one explicitly approved task", opts: [...common,
      { dest: "expected_epoch", flags: ["--expected-epoch"], kind: "int", help: "required current lease epoch" },
      { dest: "approved", flags: ["--approved"], kind: "bool", help: "approve this one task invocation" },
      { dest: "task_file", flags: ["--task-file"], kind: "str", help: "JSON task file" },
    ] },
  ];
}

export function runLeadRuntime(argv: string[], io: { out(s: string): void; err(s: string): void }): number {
  try {
    const { args, cmd } = parse({ name: "lead", help: "lead loop", sub: runtimeSpecs() }, argv, ["orch", "lead"]);
    // Validate authorization and usage before loading config or creating any locks/files.
    if (!args.session || (cmd.name === "tick" && (!args.approved || !args.expected_epoch || !args.tick))
      || (cmd.name === "dispatch" && (!args.approved || !args.expected_epoch || !args.task_file))) {
      throw new Error("--session is required; tick/dispatch also require --approved and --expected-epoch with their tick/task file");
    }
    const cfg = C.loadOrDefault(), l = cfg.lease ?? {}, m = cfg.messages ?? {};
    const lease = new Lease(C.expand(l.path ?? join(C.orchHome(), "lease.json")),
      C.configNumber(l.default_seconds, 3600, "[lease] default_seconds", 1),
      C.configNumber(l.min_seconds, 60, "[lease] min_seconds", 1));
    const box = new Messages(C.expand(m.path ?? join(C.orchHome(), "messages.jsonl")),
      C.expand(m.cursors ?? join(C.orchHome(), "cursors")));
    const loop = new LeadLoop(lease, box, cfg);
    const opts = {
      session: args.session, seconds: args.seconds ?? undefined, expectedEpoch: args.expected_epoch,
      tick: args.tick, approved: args.approved,
    };
    const [code, result] = cmd.name === "dispatch" ? loop.dispatch({ ...opts, taskFile: args.task_file })
      : loop.run(cmd.name as "boot" | "tick", opts);
    io.out(JSON.stringify(result) + "\n");
    return code;
  } catch (e: any) {
    if (e instanceof HelpRequested) { io.out(e.text + "\n"); return 0; }
    io.err("orch lead: " + JSON.stringify(e.message ?? "runtime unavailable") + "\n");
    return 2;
  }
}
