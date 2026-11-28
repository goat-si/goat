import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { v1Aliases } from "./vite-plugin-v1.ts";

// v1Aliases: tests that import @v1/surfaces or seam modules resolve the lifted tree the way the app does. Lifted v1
// directories are excluded: their tests stay in v1 (lifts skip them), only seam tests run here.
export default defineConfig({
  plugins: [v1Aliases(fileURLToPath(new URL(".", import.meta.url)))],
  test: { include: ["src/**/*.test.{ts,tsx}"], exclude: ["src/v1/{apps,packages,components,lib,hooks,state}/**"], environment: "node" },
});
