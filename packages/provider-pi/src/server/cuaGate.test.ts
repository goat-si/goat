import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { openPiCuaGate, writePiCuaGate } from "./cuaGate.ts";

const proxy = (control: string): CuaDriverMcpConfiguration => ({
  command: "/goat/node",
  args: ["cua-lease-proxy", "--control", control],
  environment: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
});

it.effect("tells Pi to keep, swap to, or close the driver each turn (#1564)", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* openPiCuaGate(fileSystem);
    const gate = { path, key: McpProviderSession.cuaDriverKey(proxy("control:launch")) };
    const session = (cuaDriver?: CuaDriverMcpConfiguration) =>
      ({
        ...(cuaDriver === undefined ? {} : { cuaDriver }),
      }) as McpProviderSession.McpProviderSessionConfig;
    const turn = (cuaDriver?: CuaDriverMcpConfiguration) =>
      writePiCuaGate(fileSystem, gate, session(cuaDriver)).pipe(
        Effect.andThen(fileSystem.readFileString(path)),
      );

    assert.equal(yield* turn(proxy("control:launch")), "on");
    // Stop minted a new control: Pi gets its descriptor in the shape the launch env carries.
    assert.equal(yield* turn(proxy("control:after-stop")), "driver");
    assert.deepEqual(JSON.parse(yield* fileSystem.readFileString(path + ".driver")), {
      command: "/goat/node",
      args: ["cua-lease-proxy", "--control", "control:after-stop"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(yield* turn(undefined), "off");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
