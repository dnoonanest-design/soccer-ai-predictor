import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in Node environment (no DOM needed for pure maths)
    environment: "node",
    // Only pick up files in __tests__ folders or *.test.ts files
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    // Exclude compiled output
    exclude: ["dist/**"],
    // Concise reporter for CI
    reporter: process.env.CI ? "verbose" : "default",
  },
});
