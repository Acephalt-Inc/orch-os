import { defineConfig } from "vitest/config";

// One forked process, test files in sequence: the suite spawns real processes and takes real
// file locks, and it must stay gentle on a busy machine.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
