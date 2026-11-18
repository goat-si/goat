import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("Linux desktop artifact", (it) => {
  it.effect("names the Electron window class in the Linux desktop entry", () =>
    Effect.gen(function* () {
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );
      assert.nestedPropertyVal(linux, "linux.desktop.entry.StartupWMClass", "com.t3tools.T3Code");
    }),
  );
});
