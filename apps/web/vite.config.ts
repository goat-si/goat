// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";

import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import * as Hash from "effect/Hash";
import pkg from "./package.json" with { type: "json" };
import pdfjsPkg from "pdfjs-dist/package.json" with { type: "json" };

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  DEV_PROXIED_PATH_PREFIXES,
} from "@goat/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";
import { warmBundledDevPlugin } from "./vite/warmBundledDev";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Signal single-origin dev explicitly; loadRepoEnv can restore deleted URL keys from .env.
const isSingleOriginDev = process.env.GOAT_SINGLE_ORIGIN_DEV === "1";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
const configuredRelayUrl = repoEnv.VITE_T3CODE_RELAY_URL?.trim() || "";
const configuredClerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || "";
const configuredClerkJwtTemplate = repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || "";
const configuredClerkCliOAuthClientId = repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || "";
const configuredRelayTracingUrl = repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || "";
const configuredRelayTracingDataset = repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || "";
const configuredRelayTracingToken = repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || "";
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredReleaseChannel =
  process.env.GOAT_BUILT_DEV === "1" ? "dev" : process.env.VITE_RELEASE_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredDesktopUpdateRepository = process.env.GOAT_DESKTOP_UPDATE_REPOSITORY?.trim() || "";
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.GOAT_WEB_SOURCEMAP?.trim().toLowerCase();

// `vp run dev --share --built` rebuilds on every change. The license manifest
// is about 2 s of each build, and nothing in that mode reads it.
const builtDev = process.env.GOAT_BUILT_DEV === "1";

const bundledDevEnv = process.env.GOAT_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
      "../../packages/shared/src/testing/gitEnv.setup.ts",
    ],
    globalSetup: [
      "../../scripts/lib/node-runtime.ts",
      "../../packages/shared/src/testing/gitConfigGuard.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

// Anything that renders React or touches the DOM is named *.browser.test.{ts,tsx} and runs
// in headless Chromium through the same plugins as the app, so it exercises compiled code.
// Vitest's fixed browser API port (63315) collides when two checkouts run
// browser tests at once, and `server.strictPort` above is inherited, so the
// second run fails instead of moving on. Hash the checkout path like
// scripts/dev-runner.ts does, into 61000-64999 (above Linux's ephemeral range).
const browserTestPortBase = 61_000;
const browserTestPortSpan = 4_000;
const hashedBrowserTestApiPort =
  browserTestPortBase + ((Hash.string(import.meta.dirname) >>> 0) % browserTestPortSpan);

const canListen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "localhost" }, () => server.close(() => resolve(true)));
  });

// Windows reserves blocks of its dynamic port range for Hyper-V and WinNAT (see
// `netsh int ipv4 show excludedportrange protocol=tcp`). Binding inside one fails with
// EACCES, which `strictPort: false` does not retry, so the whole run fails to start.
const findBrowserTestApiPort = async () => {
  for (let step = 0; step < browserTestPortSpan; step++) {
    const port =
      browserTestPortBase +
      ((hashedBrowserTestApiPort - browserTestPortBase + step) % browserTestPortSpan);
    if (await canListen(port)) return port;
  }
  return hashedBrowserTestApiPort;
};

const browserTestApiPort =
  // oxlint-disable-next-line goat/no-global-process-runtime -- build config, outside Effect.
  NodeOS.platform() === "win32" ? await findBrowserTestApiPort() : hashedBrowserTestApiPort;

const browserTestProject = {
  extends: true,
  // Pre-bundle lazy browser and worker dependencies to avoid mid-run reloads.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "@base-ui/react/autocomplete",
      "@effect/vitest",
      "zustand/vanilla",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "dompurify",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    // One Vite server, one Chromium process and one Playwright connection serve every page, and
    // none of them scale with cores. Vitest's default (one page per core, alongside the unit
    // workers) opens dozens of pages on the EPYC runners, where clicks, workers and highlighting
    // stall past their timeouts. A different worker count needs its own group, so the browser
    // project runs after the unit project.
    maxWorkers: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 1)),
    sequence: { groupOrder: 1 },
    setupFiles: ["./src/test/browserNoMotion.ts", "./test/browserSetup.ts"],
    globalSetup: ["../../scripts/lib/node-runtime.ts"],
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
        // test/reportMockFactoryFailure.ts: a failed vi.mock factory's cause, which the browser
        // RPC and the default silent mode would otherwise both drop (#928).
        reportMockFactoryFailure: (_context, message: string) => {
          process.stderr.write(`${message}\n`);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// Render scenarios count React commits; they run only through scripts/render-metrics.ts,
// which reads the per-scenario reports this command writes.
const renderScenariosProject = {
  ...browserTestProject,
  test: {
    ...browserTestProject.test,
    name: "renders",
    include: ["test/*.renders.tsx"],
    // App scenarios mount the whole app per test, which outlasts 15s on a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./test/renderCounter.ts", ...browserTestProject.test.setupFiles],
    browser: {
      ...browserTestProject.test.browser,
      // Vitest names each instance in place, so a shared array would clash with the browser project.
      instances: [{ browser: "chromium" }],
      commands: {
        ...browserTestProject.test.browser.commands,
        writeRenderReport: async (_context, scenario: string, json: string) => {
          const directory = process.env.GOAT_RENDER_REPORT_DIR;
          if (!directory) throw new Error("GOAT_RENDER_REPORT_DIR is not set");
          await NodeFSP.writeFile(`${directory}/${scenario}.json`, json);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop connects directly to the backend; derive its target from the explicit WebSocket URL.
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(process.env.GOAT_PORT, configuredWsUrl);

// Brotli quality 5 encodes in hundreds of ms; default quality 11 would replace transfer stalls with encode stalls.
function devCompressionPlugin(): Plugin {
  return {
    name: "goat:dev-compression",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// A static import cycle between chunks can run a chunk before the values it imports exist,
// which blanks the app at boot. Fail the build instead of shipping it.
function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "t3code:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) {
          this.error(`Chunk import cycle: ${[...path.slice(start), fileName].join(" -> ")}`);
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

// Allow Tailnet hosts for sharing; Tailscale-controlled DNS prevents attacker rebinding.
const configuredAllowedHosts = (process.env.GOAT_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(() => {
  return {
    run: {
      tasks: {
        // tsc (tsc-rs) rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
        typecheck: {
          command: "tsc --noEmit",
          cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
        },
      },
    },
    assetsInclude: ["**/*.wasm"],
    plugins: [
      devCompressionPlugin(),
      chunkCycleGuardPlugin(),
      builtDev
        ? undefined
        : thirdPartyLicensesPlugin({
            bundleName: "web",
            configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
            packageManifests: [
              { bundle: "web", path: new URL("./package.json", import.meta.url) },
              { bundle: "server", path: new URL("../server/package.json", import.meta.url) },
              { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
            ],
          }),
      tanstackRouter({ autoCodeSplitting: true }),
      react({ compiler: true }),
      tailwindPlugins(bundledDev),
      warmBundledDevPlugin(),
    ],
    optimizeDeps: {
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "@pierre/diffs/edit",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
      ],
    },
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      // Override .env URLs with empty values in single-origin dev so clients use window.location.origin.
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
        configuredClerkCliOAuthClientId,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(configuredRelayTracingUrl),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(
        configuredRelayTracingDataset,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(configuredRelayTracingToken),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.GOAT_DESKTOP_UPDATE_REPOSITORY": JSON.stringify(
        configuredDesktopUpdateRepository,
      ),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(configuredReleaseChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@betteroffice/fonts-cjk": new URL(
          "./src/components/files/office/fonts-cjk.ts",
          import.meta.url,
        ).pathname,
      },
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      // Warm the module graph before first request to avoid serial import transforms over tailnet.
      // Bundled dev ignores this; warmBundledDevPlugin handles it there.
      ...(process.env.VITEST
        ? {}
        : {
            warmup: {
              clientFiles: ["./src/main.tsx"],
            },
          }),
      ...(devProxyTarget
        ? {
            // Share prefixes with the backend catch-all so the proxy and 404 lists cannot drift.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: !DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix),
                  ...(prefix === "/ws" || prefix === "/api" || prefix === "/hub"
                    ? { ws: true }
                    : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron needs an explicit HMR host; elsewhere derive it from page origin for Tailscale/LAN.
      ...(explicitHost
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    // Tailwind needs devSourcemap to avoid Rolldown SOURCEMAP_BROKEN on sourcemapped builds.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
      rolldownOptions: {
        output: {
          // PDF.js resolves decoder modules and ICC data relative to wasmUrl.
          assetFileNames: (asset) =>
            asset.originalFileNames.some((path) => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
              ? `assets/pdfjs-${pdfjsPkg.version}/[name][extname]`
              : "assets/[name]-[hash][extname]",
        },
      },
    },
    worker: { format: "es" },
    test: {
      projects: [
        defineProject(unitTestProject),
        defineProject(browserTestProject),
        defineProject(renderScenariosProject),
      ],
    },
  };
});
