import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { catalog, dependencies } from "./agentSurface.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const clientInfo = { name: "schema-test", version: "1.0.0" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo,
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
  getClient: Effect.die("unused"),
});

it.effect(
  "compacts tagged inputs without admitting a missing action field or an unknown argument",
  () => {
    const calls: Array<unknown> = [];
    const toolkit = Toolkit.make(
      Tool.make("schema_probe", {
        parameters: Schema.Struct({
          target: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        }),
        success: Schema.String,
      }),
    );
    const layer = McpHttpServer.toolkitRegistration(
      toolkit,
      McpToolAccess.toLayer(toolkit, {
        schema_probe: McpToolAccess.reads((input) =>
          Effect.sync(() => {
            calls.push(input);
            return "accepted";
          }),
        ),
      }),
    ).pipe(
      Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const callTool = (name: string, args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(server.tools[0]?.tool.inputSchema.properties?.target).toEqual({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      });
      yield* callTool("schema_probe", { target: { kind: "url" } }).pipe(Effect.flip);
      const unknown = yield* callTool("schema_probe", {
        target: { kind: "url", url: "https://example.test" },
        typo: true,
      });
      expect(unknown.isError).toBe(true);
      expect(calls).toEqual([]);
      yield* callTool("schema_probe", { target: { kind: "number", number: 1 } });
      expect(calls).toEqual([{ target: { kind: "number", number: 1 } }]);
    }).pipe(Effect.provide(layer));
  },
);

const registered = catalog.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("omits redundant safe-integer bounds from every registered input schema", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const { tool } of server.tools) {
      const serialized = JSON.stringify(tool.inputSchema);
      expect(serialized, tool.name).not.toContain(`"maximum":${Number.MAX_SAFE_INTEGER}`);
      expect(serialized, tool.name).not.toContain(`"minimum":${Number.MIN_SAFE_INTEGER}`);
    }
  }).pipe(Effect.provide(registered)),
);
