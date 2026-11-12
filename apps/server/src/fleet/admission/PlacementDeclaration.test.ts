import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import { PlacementAdmissionEnabled, PlacementArgument } from "./PlacementKey.ts";

const clientInfo = { name: "placement-declaration-test", version: "1.0.0" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo,
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
  getClient: Effect.die("unused"),
});

const served = (enabled: boolean) => {
  const calls: Array<unknown> = [];
  const toolkit = Toolkit.make(
    Tool.make("goat_thread_launch", {
      parameters: Schema.Struct({
        title: Schema.String,
        placement: Schema.optional(PlacementArgument),
      }),
      success: Schema.String,
    }),
  );
  const layer = McpHttpServer.toolkitRegistration(
    toolkit,
    McpToolAccess.toLayer(toolkit, {
      goat_thread_launch: McpToolAccess.reads((input) =>
        Effect.sync(() => {
          calls.push(input);
          return "launched";
        }),
      ),
    }),
  ).pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(PlacementAdmissionEnabled, enabled)),
  );
  return { calls, layer };
};

const placement = { ownerKey: "goal:g:a", attempt: 0, issuedAt: "2026-11-01T00:00:00.000Z" };

it.effect.each([false, true])(
  "goat_thread_launch declares placement only while admission is on, and an undeclared placement is refused before the handler (on: %s)",
  (enabled) => {
    const { calls, layer } = served(enabled);
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const properties = server.tools[0]?.tool.inputSchema.properties ?? {};
      expect(Object.hasOwn(properties, "placement")).toBe(enabled);
      expect(Object.hasOwn(properties, "title")).toBe(true);
      const result = yield* server
        .callTool({ name: "goat_thread_launch", arguments: { title: "t", placement } })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.isError === true).toBe(!enabled);
      expect(calls.length).toBe(enabled ? 1 : 0);
    }).pipe(Effect.provide(layer));
  },
);
