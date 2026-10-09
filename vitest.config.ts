import { defineConfig } from "vitest/config";

// One forked process, test files in sequence: the suite spawns real processes and takes real
// file locks, and it must stay gentle on a busy machine.
// Starting npm and node takes several times longer on Windows.
const timeout = process.platform === "win32" ? 180_000 : 60_000;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // One event-loop turn after each test; see the comment in the setup file.
    setupFiles: ["tests/_yield.setup.ts"],
    testTimeout: timeout,
    hookTimeout: timeout,
  },
});
