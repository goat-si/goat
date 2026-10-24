import "vite-plus/test/config";
// Adopts legacy T3 env names before anything reads the environment.
import "@goat/contracts/adoptLegacyEnv";
import { defaultInclude, defineConfig } from "vite-plus";

import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";
import { resolveBuildCommitTime } from "../../scripts/lib/build-commit-time.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();

// The packaged app then installs just those externals, instead of a full
// production install of apps/desktop's dependency tree next to a server bundle
// that already carries its own copy of the same libraries.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
const shouldLaunchElectronAfterPack = process.env.GOAT_DESKTOP_DEV === "1";
const publicConfigDefine = {
  __GOAT_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
};
// The main process stamps the same commit time as the server archive it ships, so the SSH
// runner can order that archive against a remote host's runtime (apps/desktop/src/ssh).
const mainProcessDefine = {
  ...publicConfigDefine,
  __GOAT_BUILD_COMMIT_TIME__: JSON.stringify(resolveBuildCommitTime(import.meta.dirname)),
};

// Electron runs a sandboxed preload as the body of a function whose parameters include
// require, process, Buffer, global, setImmediate, clearImmediate, exports and module. A
// top-level declaration with one of those names (Effect declares setImmediate) is then a
// SyntaxError and the preload never loads, so each preload bundle runs inside its own function.
// scripts/build-desktop-artifact.ts checks the built files the same way Electron loads them.
const sandboxedPreload = {
  banner: { js: "(() => {" },
  footer: { js: "})();" },
} as const;

export default defineConfig({
  run: {
    tasks: {
      build: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["goat#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && cross-env GOAT_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["goat#build"],
        cache: false,
      },
      "dev:bundle": {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["goat#build"],
        cache: false,
      },
      // tsc (tsc-rs) rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
      typecheck: {
        command: "tsc --noEmit",
        cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: mainProcessDefine,
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: [
        "src/electron/WindowsForegroundFocusWorker.ts",
        "src/snapShot/GlobalShiftShortcutWorker.ts",
        "src/snapShot/RegionSnapShotWorker.ts",
        "src/snapShot/SnapShotAccessibilityWorker.ts",
      ],
      clean: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
    },
    {
      // boot.cjs requires the other two at runtime, so all three stay separate files.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/boot.ts", "src/compileCache.ts"],
      clean: false,
      deps: {
        neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      ...sandboxedPreload,
      deps: {
        // Sandboxed Electron preloads cannot reliably resolve package imports
        // from inside the packaged ASAR. Bundle Clerk's preload bridge into the
        // preload artifact instead of leaving a runtime require() behind. The
        // progress decoder also needs the contract schemas and their runtime.
        alwaysBundle: (id) =>
          id === "@clerk/electron" ||
          id.startsWith("@clerk/electron/") ||
          id === "@goat/contracts" ||
          id === "effect" ||
          id.startsWith("effect/") ||
          id === "@goat/contracts/legacyT3Names",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      ...sandboxedPreload,
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
      ...sandboxedPreload,
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/mac-permission-preload.ts"],
      ...sandboxedPreload,
    },
  ],
  test: {
    include: [...defaultInclude, "../../native/kde-snap-shot/src/*.test.ts"],
    alias: [
      {
        find: /^electron$/,
        replacement: `${import.meta.dirname}/src/testing/electronStub.ts`,
      },
    ],
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
      "../../packages/shared/src/testing/gitEnv.setup.ts",
    ],
    globalSetup: ["../../packages/shared/src/testing/gitConfigGuard.ts"],
  },
});
