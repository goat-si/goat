import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { createDevRunnerEnv } from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner home", (it) => {
  it.effect("expands a home-relative GOAT home the way the server does", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const homeFor = (goatHome: string) =>
        createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          goatHome,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, "/home/dev"),
          Effect.map((env) => env.GOAT_HOME),
        );

      assert.equal(yield* homeFor("~/goat-dev"), path.join("/home/dev", "goat-dev"));
      assert.equal(yield* homeFor("~"), "/home/dev");
      assert.equal(yield* homeFor("~\\goat-dev"), path.join("/home/dev", "goat-dev"));
      assert.equal(yield* homeFor("  ~/goat-dev  "), path.join("/home/dev", "goat-dev"));
      assert.equal(yield* homeFor("~someone/goat-dev"), path.resolve("~someone/goat-dev"));
      assert.equal(yield* homeFor("relative/goat-dev"), path.resolve("relative/goat-dev"));
      assert.equal(yield* homeFor("/tmp/goat-dev"), path.resolve("/tmp/goat-dev"));
    }),
  );
});
