import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/gitEnv.setup.ts",
    ],
    globalSetup: ["../../scripts/lib/node-runtime.ts", "../shared/src/testing/gitConfigGuard.ts"],
  },
});
