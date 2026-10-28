import { defineConfig, type ViteUserConfig } from "vite-plus";
import "vite-plus/test/config";
import { getViteConfig } from "astro/config";

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

// Root-level runs (CI's changed-test list) start elsewhere; Astro resolves src/pages from its root.
export default getViteConfig(config, { root: import.meta.dirname });
