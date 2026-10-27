import { defineConfig } from "vite-plus";
import "vite-plus/test/config";
import { getViteConfig } from "astro/config";

export default getViteConfig(
  defineConfig({
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
  }),
);
