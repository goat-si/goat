import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// `vp test run` from this directory does not walk up to the repo root config, so the
// root testTimeout (and the long temp-dir setup) would not apply. Fixture SSH tests
// exceed vitest's 5s default.
export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 180_000,
    testTimeout: 180_000,
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/gitEnv.setup.ts",
    ],
    globalSetup: ["../../scripts/lib/node-runtime.ts", "../shared/src/testing/gitConfigGuard.ts"],
  },
});
