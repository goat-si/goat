import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  previousEntry: "",
  symlinkSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: vi.fn(),
    getVersion: () => "0.1.11",
    isPackaged: false,
    getAppPath: () => "/tmp/.mount_GOAT/resources/app.asar",
    commandLine: { appendSwitch: vi.fn(), getSwitchValue: () => "", hasSwitch: () => false },
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

vi.mock("node:fs", () => ({
  readFileSync: (path: string) => {
    if (path.endsWith(".desktop")) return mocks.previousEntry;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  symlinkSync: mocks.symlinkSync,
}));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

// What an installed versioned AppImage does with a version-free feed (electron-updater 6.8.9
// AppImageUpdater.doInstall): it deletes its own file, moves the update beside it under the feed's
// name and relaunches that with APPIMAGE_SILENT_INSTALL=true.
const launchAfterUpdate = (env: Record<string, string>) => {
  mocks.previousEntry =
    "[Desktop Entry]\nType=Application\nName=GOAT\nExec=/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage %U\n";
  mocks.symlinkSync.mockReset();
  vi.stubEnv("VITE_DEV_SERVER_URL", "");
  vi.stubEnv("XDG_DATA_HOME", "/xdg");
  vi.stubEnv("GOAT_DESKTOP_LAUNCHER_PATH", "");
  vi.stubEnv("APPIMAGE", "/home/sam/Apps/GOAT-x86_64.AppImage");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return Effect.scoped(
    Layer.build(
      DesktopPreReadyPlatform.layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
      ),
    ),
  ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
};

describe("DesktopPreReadyPlatform after an AppImage update", () => {
  it.effect("keeps the old versioned path working as a link to the version-free AppImage", () =>
    Effect.gen(function* () {
      yield* launchAfterUpdate({ APPIMAGE_SILENT_INSTALL: "true" });
      assert.deepEqual(mocks.symlinkSync.mock.calls, [
        ["GOAT-x86_64.AppImage", "/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage"],
      ]);
    }),
  );

  it.effect("leaves a launch the updater did not start alone", () =>
    Effect.gen(function* () {
      yield* launchAfterUpdate({ APPIMAGE_SILENT_INSTALL: "" });
      assert.deepEqual(mocks.symlinkSync.mock.calls, []);
    }),
  );
});
