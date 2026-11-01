import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as RuntimeControl from "./runtimeControl.ts";
import * as ServerConfig from "./config.ts";

it.effect("publishes a fresh private token per acquisition and compares it exactly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const config = ServerConfig.layerTest(process.cwd(), root);
    const read = Effect.gen(function* () {
      const settings = yield* ServerConfig.ServerConfig;
      const control = yield* RuntimeControl.RuntimeControl;
      const tokenPath = settings.serverRuntimeStatePath.replace(/[^/]+$/, "runtime-control.token");
      const token = (yield* fs.readFileString(tokenPath)).trim();
      assert.equal(token.length, 64);
      assert.equal((yield* fs.stat(tokenPath)).mode & 0o777, 0o600);
      assert.equal(control.authenticate(token), true);
      assert.equal(control.authenticate(undefined), false);
      assert.equal(control.authenticate("bad"), false);
      assert.equal(control.authenticate("0".repeat(64)), false);
      return token;
    });
    const acquire = read.pipe(
      Effect.provide(Layer.fresh(RuntimeControl.layer).pipe(Layer.provideMerge(config))),
    );
    const first = yield* acquire;
    const second = yield* acquire;
    assert.notEqual(first, second);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
