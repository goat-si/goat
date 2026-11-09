import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("macOS Calendar access", (it) => {
  it.effect("declares nonempty Calendar purposes for hosted commands", () =>
    Effect.gen(function* () {
      for (const signed of [false, true]) {
        const config = yield* createBuildConfig(
          "mac",
          "dmg",
          "1.2.3",
          signed,
          false,
          undefined,
          undefined,
        );
        const info = (config.mac as { extendInfo: Record<string, unknown> }).extendInfo;
        for (const key of [
          "NSCalendarsUsageDescription",
          "NSCalendarsFullAccessUsageDescription",
          "NSCalendarsWriteOnlyAccessUsageDescription",
        ]) {
          assert.isString(info[key]);
          assert.isNotEmpty(info[key]);
        }
      }
    }),
  );
});
