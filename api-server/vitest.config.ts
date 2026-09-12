import { defineConfig } from "vitest/config";

// Unit tests import modules that construct the lazy PostgreSQL pool. They do
// not connect unless a test explicitly exercises persistence, but the package
// requires a syntactically valid URL during module initialisation.
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

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
