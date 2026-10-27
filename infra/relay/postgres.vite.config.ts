import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["infra/relay/src/**/*.postgres.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
