import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // The integration tests each spin up PGlite and replay every migration in
    // beforeAll, and the timezone property test sweeps years of dates. Both sit
    // well inside the 5s/10s defaults locally but not on a loaded CI runner,
    // where they were timing out only when the files ran alongside each other.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
