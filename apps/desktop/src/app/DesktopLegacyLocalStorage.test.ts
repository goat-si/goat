import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

vi.mock("electron", () => ({}));

it.effect("a GOAT profile never imports or marks upstream V1 Local Storage", () =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/isolated",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/install/app.asar",
          isPackaged: true,
          resourcesPath: "/install",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
      ),
    );
    const unexpected = () =>
      Effect.die("GOAT must not probe/write upstream profile migration state");
    const service = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage.pipe(
      Effect.provide(
        DesktopLegacyLocalStorage.layer.pipe(
          Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(
                FileSystem.FileSystem,
                FileSystem.makeNoop({
                  exists: unexpected,
                  readDirectory: unexpected,
                  readFileString: unexpected,
                  writeFileString: unexpected,
                }),
              ),
            ),
          ),
        ),
      ),
    );
    yield* service.load("/isolated/profiles/goat-desktop");
    assert.isTrue(Option.isNone(yield* service.take));
    yield* service.complete;
    assert.isTrue(Option.isNone(yield* service.take));
  }).pipe(Effect.scoped),
);
