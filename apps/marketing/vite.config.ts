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
const astro = await import("astro/config").catch(() => undefined);

// Root-level runs (CI's changed-test list) start elsewhere; Astro resolves src/pages from its root.
export default astro ? astro.getViteConfig(config, { root: import.meta.dirname }) : config;
