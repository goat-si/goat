import { defineConfig } from "@playwright/test";

// Lanes share a machine (mac-studio runs several worktrees): each run starts its own dev server, so tests never hit
// another worktree's server on a reused port. GOAT2_WEB_PORT picks the port (default 5733); a busy port fails loudly.
const port = Number(process.env.GOAT2_WEB_PORT ?? 5733);

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${port}`, deviceScaleFactor: 1, browserName: "chromium", actionTimeout: 5000 },
  webServer: { command: `vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false },
});
