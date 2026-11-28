import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { v1Aliases } from "./vite-plugin-v1.ts";

// v1Aliases: tests that import @v1/surfaces or seam modules resolve the lifted tree the way the app does.
export default defineConfig({
  plugins: [v1Aliases(fileURLToPath(new URL(".", import.meta.url)))],
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" },
});
