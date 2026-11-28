import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { v1Aliases } from "./vite-plugin-v1.ts";

// v1Aliases: tests under src/v1 (the lane F seam) import lifted v1 modules, which resolve through the v1 alias map.
export default defineConfig({
  plugins: [v1Aliases(fileURLToPath(new URL(".", import.meta.url)))],
  test: { include: ["src/**/*.test.{ts,tsx}"], exclude: ["src/v1/{apps,packages,components,lib,hooks,state}/**"], environment: "node" },
});
