import * as NodeServices from "@effect/platform-node/NodeServices";
import { type CuaDriverMcpConfiguration, ProviderDriverKind } from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { computerUseAttachment, withComputerUse } from "./ComputerUseAttachment.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import * as CuaDriver from "./CuaDriver.ts";

export const threadAttachmentLayer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      NodeServices.layer,
      ServerSettings.ServerSettingsService.layerTest({ enableCua: true }),
    ),
  ),
);

export const threadDriver: CuaDriverMcpConfiguration = {
  command: "/fixture/cua-driver",
  args: ["mcp", "--socket", "/tmp/fixture-cua.sock"],
  socketPath: "/tmp/fixture-cua.sock",
  environment: [{ name: "DISPLAY", value: ":7" }],
};

// Only native acquisition and the proxy executable are substituted; controls use the real service.
export const prepareThreadAttachment = Effect.fn("ThreadAttachmentTest.prepare")(function* (
  config: McpProviderSessionConfig,
  mcp = threadDriver,
  x11Display?: CuaDriver.CuaX11Display,
) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const driver = CuaDriver.CuaDriver.of({
    enabled: Effect.succeed(true),
    listedApps: Effect.succeedNone,
    appCatalog: Effect.succeed([]),
    acquire: Effect.succeedSome(mcp),
    x11Display: Effect.succeed(Option.fromUndefinedOr(x11Display)),
    lastFailure: Effect.succeedNone,
    block: Effect.succeed(undefined),
    status: Effect.succeed({ platform: "linux", running: true }),
    computerUse: Effect.die("unused"),
    admitEnable: Effect.die("unused"),
  });
  const attachment = yield* computerUseAttachment(Option.some(driver), {
    threadId: config.threadId,
    driver: ProviderDriverKind.make("codex"),
    interactionMode: "default",
    readOnly: false,
    origin: { _tag: "interactive" },
    leases: Option.some({
      ...leases,
      proxy: { command: "/fixture/node", entrypoint: "/fixture/goat.mjs" },
    }),
  });
  if (attachment._tag !== "proxied") return yield* Effect.die("expected computer use");
  const session = withComputerUse(config, attachment, "/api/computer-use/lease");
  if (session.cuaDriver === undefined) return yield* Effect.die("expected proxy descriptor");
  return { attachment, session, descriptor: session.cuaDriver };
});
