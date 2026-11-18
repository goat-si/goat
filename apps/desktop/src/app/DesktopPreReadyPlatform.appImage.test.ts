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
const launchAfterUpdate = (
  env: Record<string, string>,
  desktopEntryTarget = "/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage",
) => {
  mocks.previousEntry = `[Desktop Entry]\nType=Application\nName=GOAT\nExec=${desktopEntryTarget} %U\n`;
  mocks.symlinkSync.mockReset();
  vi.stubEnv("VITE_DEV_SERVER_URL", "");
  vi.stubEnv("XDG_DATA_HOME", "/xdg");
  vi.stubEnv("GOAT_DESKTOP_LAUNCHER_PATH", "");
  vi.stubEnv("APPIMAGE", "/home/sam/Apps/GOAT-x86_64.AppImage");
  vi.stubEnv("GOAT_APPIMAGE_PREVIOUS_PATH", undefined);
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
  it.effect(
    "restores the updating AppImage path when another channel wrote the desktop entry",
    () =>
      Effect.gen(function* () {
        const previousPath = "/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage";
        yield* launchAfterUpdate(
          {
            APPIMAGE_SILENT_INSTALL: "true",
            GOAT_APPIMAGE_PREVIOUS_PATH: previousPath,
          },
          "/home/sam/Apps/GOAT-0.1.10-nightly.20261117.376-x86_64.AppImage",
        );
        assert.deepEqual(mocks.symlinkSync.mock.calls, [["GOAT-x86_64.AppImage", previousPath]]);
      }),
  );

  it.effect("keeps the exact old nightly path working in a directory with shell characters", () =>
    Effect.gen(function* () {
      const directory = '/home/sam/My "100%" $Apps\\x';
      const previousPath = directory + "/GOAT-0.1.10-nightly.20261117.376-arm64.AppImage";
      yield* launchAfterUpdate({
        APPIMAGE_SILENT_INSTALL: "true",
        APPIMAGE: directory + "/GOAT-Nightly-arm64.AppImage",
        GOAT_APPIMAGE_PREVIOUS_PATH: previousPath,
      });
      assert.deepEqual(mocks.symlinkSync.mock.calls, [
        ["GOAT-Nightly-arm64.AppImage", previousPath],
      ]);
    }),
  );

  it.effect.each([
    {
      reason: "the updater supplied no previous path",
      previous: "",
      current: "/home/sam/Apps/GOAT-x86_64.AppImage",
    },
    {
      reason: "the previous path was relative",
      previous: "GOAT-0.1.10-x86_64.AppImage",
      current: "/home/sam/Apps/GOAT-x86_64.AppImage",
    },
    {
      reason: "the previous path was in a different folder",
      previous: "/home/sam/Other/GOAT-0.1.10-x86_64.AppImage",
      current: "/home/sam/Apps/GOAT-x86_64.AppImage",
    },
    {
      reason: "the previous path had no version",
      previous: "/home/sam/Apps/custom.AppImage",
      current: "/home/sam/Apps/GOAT-x86_64.AppImage",
    },
    {
      reason: "the install stayed at the same filename",
      previous: "/home/sam/Apps/GOAT-x86_64.AppImage",
      current: "/home/sam/Apps/GOAT-x86_64.AppImage",
    },
    {
      reason: "the update still uses versioned names",
      previous: "/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage",
      current: "/home/sam/Apps/GOAT-0.1.11-x86_64.AppImage",
    },
  ])("leaves launch paths alone when $reason", ({ previous, current }) =>
    Effect.gen(function* () {
      yield* launchAfterUpdate({
        APPIMAGE_SILENT_INSTALL: "true",
        APPIMAGE: current,
        GOAT_APPIMAGE_PREVIOUS_PATH: previous,
      });
      assert.deepEqual(mocks.symlinkSync.mock.calls, []);
    }),
  );

  it.effect("leaves a launch the updater did not start alone", () =>
    Effect.gen(function* () {
      yield* launchAfterUpdate({
        APPIMAGE_SILENT_INSTALL: "",
        GOAT_APPIMAGE_PREVIOUS_PATH: "/home/sam/Apps/GOAT-0.1.10-x86_64.AppImage",
      });
      assert.deepEqual(mocks.symlinkSync.mock.calls, []);
    }),
  );
});
