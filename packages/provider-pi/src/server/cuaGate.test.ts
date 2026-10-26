import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { openPiCuaGate, writePiCuaGate } from "./cuaGate.ts";

const proxy = (fingerprint: string): CuaDriverMcpConfiguration => ({
  command: "/goat/node",
  args: ["cua-lease-proxy", "--thread", "thread:fixture", "--driver-fingerprint", fingerprint],
  environment: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
});

it.effect("tells Pi to keep, swap to, or close the driver each turn (#1564)", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* openPiCuaGate(fileSystem);
    const gate = { path, key: McpProviderSession.cuaDriverKey(proxy("driver:launch")) };
    const session = (cuaDriver?: CuaDriverMcpConfiguration) =>
      ({
        ...(cuaDriver === undefined ? {} : { cuaDriver }),
      }) as McpProviderSession.McpProviderSessionConfig;
    const turn = (cuaDriver?: CuaDriverMcpConfiguration) =>
      writePiCuaGate(fileSystem, gate, session(cuaDriver)).pipe(
        Effect.andThen(fileSystem.readFileString(path)),
      );

    assert.equal(yield* turn(proxy("driver:launch")), "on");
    // A new control keeps this launch identity; only a different driver swaps the extension.
    assert.equal(yield* turn(proxy("driver:launch")), "on");
    assert.equal(yield* turn(proxy("driver:changed")), "driver");
    assert.deepEqual(JSON.parse(yield* fileSystem.readFileString(path + ".driver")), {
      command: "/goat/node",
      args: [
        "cua-lease-proxy",
        "--thread",
        "thread:fixture",
        "--driver-fingerprint",
        "driver:changed",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(yield* turn(undefined), "off");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
