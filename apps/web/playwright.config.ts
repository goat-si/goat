import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5733", deviceScaleFactor: 1, browserName: "chromium", actionTimeout: 5000 },
  webServer: { command: "vite --port 5733 --strictPort", url: "http://localhost:5733", reuseExistingServer: true },
});
