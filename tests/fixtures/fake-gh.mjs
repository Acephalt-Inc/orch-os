// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// A stand-in for the GitHub CLI, used by tests/network-sentence.test.ts as the `gh` first on PATH.
// It appends its arguments as one JSON line to the file named by FAKE_GH_LOG, then answers the
// calls ORCH-os makes. It opens no connection.
//
// The replies carry the fields each call asks for. They were written by hand from those field
// lists and from the bundled merge-gate fixtures; they were not recorded from a live service.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\n");

const HEAD = "4f2c9a1e7b3d5c8a9e0f1b2c3d4e5f6a7b8c9d0e";
const fields = args.includes("--json") ? args[args.indexOf("--json") + 1] : "";
const path = args.find((a) => a.startsWith("repos/")) ?? "";
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");

if (args[0] === "pr" && args[1] === "view" && fields === "headRefOid") {
  line({ headRefOid: HEAD });
} else if (args[0] === "pr" && args[1] === "view" && fields.startsWith("headRefOid,state,comments")) {
  line({ comments: [], headRefOid: HEAD, state: "OPEN" });
} else if (args[0] === "pr" && args[1] === "view" && fields.startsWith("author,headRefOid,reviews,labels,statusCheckRollup")) {
  line({
    author: { login: "alice" },
    headRefOid: HEAD,
    labels: [],
    reviews: [{ author: { login: "bob" }, state: "APPROVED", commit: { oid: HEAD }, body: "looks right; suite passes" }],
    statusCheckRollup: [{ name: "tests", conclusion: "SUCCESS" }],
  });
} else if (args[0] === "pr" && args[1] === "comment") {
  // the real CLI prints the address of the new comment
  process.stdout.write("https://github.com/acme/widgets/pull/7#issuecomment-1\n");
} else if (args[0] === "api" && path.endsWith("/check-runs")) {
  // one row per check run, in the projection the call asks for: head sha, name, conclusion, check suite id
  line([HEAD, "tests", "success", 11]);
} else if (args[0] === "api" && path.endsWith("/status")) {
  // no commit statuses: no rows
} else if (args[0] === "api" && path.includes("/actions/runs?head_sha=")) {
  // one row per workflow run: check suite id, workflow name
  line([11, "CI"]);
} else {
  process.stderr.write(`unknown command: ${JSON.stringify(args)}\n`);
  process.exitCode = 1;
}
