import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as CuaDriver from "./CuaDriver.ts";

/**
 * Computer use for provider-session test assemblies: a driver that is on while `enabled` says so
 * and starts `mcp` through `acquire`, and leases for interactive turns, with no grants, one
 * control per thread and a proxy to run.
 */
export const layerInteractive = (input: {
  readonly enabled: Effect.Effect<boolean>;
  readonly acquire: Effect.Effect<CuaDriverMcpConfiguration>;
}) =>
  Layer.merge(
    Layer.succeed(
      CuaDriver.CuaDriver,
      CuaDriver.CuaDriver.of({
        enabled: input.enabled,
        acquire: input.acquire.pipe(Effect.map(Option.some)),
        lastFailure: Effect.succeed(Option.none()),
        block: Effect.succeed(undefined),
        status: Effect.succeed({ platform: "darwin", running: true }),
        computerUse: Effect.die("unused"),
        admitEnable: Effect.die("unused"),
      }),
    ),
    Layer.mock(ComputerUseLeases.ComputerUseLeases)({
      foregroundApprovalEpoch: Effect.die("unused"),
      proxy: { command: "/goat/node", entrypoint: "/goat/bin.mjs" },
      channelOrigin: () => Effect.succeed(undefined),
      active: () => Effect.succeed(Option.none()),
      control: (threadId) =>
        Effect.succeed({
          controlId: "control:test",
          threadId,
          expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
        }),
      // Turns here keep their run open.
      turnEnded: () => Effect.succeed(false),
    }),
  );

export type Leases = ComputerUseLeases.ComputerUseLeases;
