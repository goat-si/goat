import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { androidSdk } from "./mobile-native-adb.ts";

it.effect("skips a stale Android home and then falls back to the platform SDK", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sdk-select-" });
    const alternate = path.join(home, "alternate");
    const fallback = path.join(home, "Library/Android/sdk");
    yield* fs.makeDirectory(path.join(alternate, "platform-tools"), { recursive: true });
    yield* fs.makeDirectory(path.join(fallback, "platform-tools"), { recursive: true });
    yield* fs.writeFileString(path.join(alternate, "platform-tools/adb"), "");
    yield* fs.writeFileString(path.join(fallback, "platform-tools/adb"), "");
    const select = (sdkRoot: string) =>
      androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          ANDROID_HOME: path.join(home, "stale"),
          ANDROID_SDK_ROOT: sdkRoot,
        }),
      );
    assert.strictEqual(yield* select(alternate), alternate);
    assert.strictEqual(yield* select(path.join(home, "also-stale")), fallback);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
