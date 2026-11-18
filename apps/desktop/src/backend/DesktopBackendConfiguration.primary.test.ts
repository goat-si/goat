import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import {
  layerBackendConfiguration,
  layerServerExposure,
  layerEnvironment,
} from "./DesktopBackendConfiguration.testkit.ts";

describe("DesktopBackendConfiguration", () => {
  it.effect("propagates the implicit packaged desktop home in the primary bootstrap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-packaged-bootstrap-" });
      yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(environment.baseDir, path.join(home, ".goat", "desktop"));
        assert.equal(config.bootstrap.goatHome, environment.baseDir);
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              layerEnvironment(home, { omitHomeOverride: true, isPackaged: true }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
