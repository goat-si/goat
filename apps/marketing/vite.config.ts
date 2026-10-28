import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { defineConfig, type ViteUserConfig } from "vite-plus";
import "vite-plus/test/config";

// Astro and Vite+ resolve separate Vite type copies; keep their recursive plugin types apart.
const config: Pick<ViteUserConfig, "root" | "test" | "run"> = defineConfig({
  test: { name: "marketing", include: ["src/**/*.test.ts"] },
  run: {
    tasks: {
      // `astro check` regenerates .astro/*.d.ts and then reads them, which
      // keeps a task out of the cache. Its real inputs are tracked as usual.
      typecheck: {
        command: "astro check",
        cache: { input: [{ auto: true }, "!.astro/**"] },
      },
    },
  },
});

// Release builds install without this package, and their task graph still loads this file.
// Only a missing Astro is skipped; an installed one that fails to load still throws.
const astro = NodeFS.existsSync(
  NodePath.join(import.meta.dirname, "node_modules/astro/package.json"),
)
  ? await import("astro/config")
  : undefined;

// Root-level runs (CI's changed-test list) start elsewhere; Astro resolves src/pages from its root.
export default astro ? astro.getViteConfig(config, { root: import.meta.dirname }) : config;
