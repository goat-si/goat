import { defineConfig } from "astro/config";

// Astro loads env with an empty prefix, and under `vp run` Vite+'s loadEnv then reports every
// variable to the task cache. Any env difference (TERM, VP_RAW_SUBCOMMAND, an agent's session
// vars) would rerun `astro check`. Without the runner client, loadEnv reads process.env directly;
// file tracking does not use this client.
delete process.env.VP_RUN_NODE_CLIENT_PATH;

// The GitHub Pages preview builds with MARKETING_SITE_URL=https://goat-si.github.io,
// MARKETING_BASE_PATH=/goat and MARKETING_NOINDEX=1. Without them the site builds for its own domain.
const site = process.env.MARKETING_SITE_URL || "https://trygoat.ai";
const base = process.env.MARKETING_BASE_PATH || "/";
const noindex = process.env.MARKETING_NOINDEX === "1" ? "1" : "0";

export default defineConfig({
  site,
  base,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    define: {
      "import.meta.env.MARKETING_NOINDEX": JSON.stringify(noindex),
    },
  },
});
