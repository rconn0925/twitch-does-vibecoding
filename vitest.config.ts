import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // e2e tests start real HTTP servers; keep a generous but bounded timeout
    testTimeout: 15_000,
  },
});
