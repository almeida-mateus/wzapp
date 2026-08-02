import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Skip the `projects/` sibling (out-of-tree user data, permission-restricted)
    // and the type-only assertion file (compiled by tsconfig.test.json, never
    // executed at runtime).
    exclude: [
      "node_modules",
      "dist",
      "examples",
      "projects",
      "test/types.test-d.ts",
    ],
  },
});
