import { assert, it } from "@effect/vitest";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import {
  layerBackendConfiguration,
  layerEnvironment,
  layerServerExposure,
} from "./DesktopBackendConfiguration.testkit.ts";

it.effect("gives the Windows and WSL backends one host scope that survives a restart", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-backend-config-test-",
    });
    const launch = Effect.gen(function* () {
      const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
      const primary = yield* configuration.resolvePrimary;
      const wsl = yield* configuration.resolveWsl({ port: 5050, distro: null });
      assert.equal(wsl.env.GOAT_DESKTOP_HOST_SCOPE, primary.env.GOAT_DESKTOP_HOST_SCOPE);
      assert.include((wsl.env.WSLENV ?? "").split(":"), "GOAT_DESKTOP_HOST_SCOPE");
      return primary.env.GOAT_DESKTOP_HOST_SCOPE;
    }).pipe(
      Effect.provide(
        layerBackendConfiguration().pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(
            DesktopWslEnvironment.layerTest({
              isAvailable: true,
              windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
              getDistroIp: () => Option.some("172.27.0.99"),
            }),
          ),
          Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
        ),
      ),
    );

    const first = yield* launch;
    assert.match(first ?? "", /^[0-9a-f]{32}$/);
    assert.equal(yield* launch, first);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
