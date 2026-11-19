import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@goat/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

it.effect.each([
  { name: "SDK_ROOT", home: "/stale", sdkRoot: "/valid", available: "/valid", expected: "/valid" },
  {
    name: "platform default",
    home: "/stale",
    sdkRoot: "/also-stale",
    available: "/home/Library/Android/sdk",
    expected: "/home/Library/Android/sdk",
  },
])(
  "skips unusable inherited SDK hints and chooses $name",
  ({ home, sdkRoot, available, expected }) =>
    Effect.gen(function* () {
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: "/home",
          ANDROID_HOME: home,
          ANDROID_SDK_ROOT: sdkRoot,
          PATH: "",
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) => Effect.succeed(file === `${available}/platform-tools/adb`),
          }),
        ),
        Effect.provide(NodePath.layerPosix),
      );
      expect(sdk.root).toBe(expected);
    }),
);
