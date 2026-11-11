import { defineConfig, mergeConfig } from "vite-plus";
import root from "../../vite.config.ts";

export default mergeConfig(
  root,
  defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      // Each suite starts its own wrangler dev, which can take a while on a cold cache.
      hookTimeout: 120_000,
    },
  }),
);
