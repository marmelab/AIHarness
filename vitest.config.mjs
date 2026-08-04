import { defineConfig } from "vitest/config";

// The harness core has no runtime dependencies beyond node: builtins, so there is one
// plain node project here. The tests spawn the hooks as real subprocesses and do real
// git/worktree work, hence the raised timeouts.
export default defineConfig({
  test: {
    name: "harness",
    environment: "node",
    include: ["hooks/**/*.test.mjs", "scripts/**/*.test.mjs"],
    // Points the hooks' tmp root at a throwaway dir so a spawned hook never logs into
    // the real /tmp (see the setup file).
    setupFiles: ["./hooks/test/setup-tmp-root.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
