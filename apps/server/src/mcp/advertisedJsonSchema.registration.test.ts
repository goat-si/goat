import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, type ProviderUpdateInput } from "@goat/contracts";
import { listedToolName } from "@goat/contracts/agentSurface/resolve";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as ProviderSettings from "../provider/ProviderSettings.ts";
import * as Settings from "../serverSettings.ts";
import { catalog, dependencies, entries, serveOverHttp, toolkits } from "./agentSurface.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import { ScreenToolkit } from "./toolkits/screen/tools.ts";

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

const nullablePaths = (schema: unknown, path = "$", found = new Set<string>()): Set<string> => {
  if (!Predicate.isObject(schema)) return found;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")))
    found.add(path);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) for (const branch of branches) nullablePaths(branch, path, found);
  }
  for (const key of ["properties", "$defs"]) {
    const properties = schema[key];
    if (Predicate.isObject(properties))
      for (const [name, property] of Object.entries(properties))
        nullablePaths(property, `${path}.${key}.${name}`, found);
  }
  for (const key of ["items", "additionalProperties"])
    nullablePaths(schema[key], `${path}.${key}`, found);
  return found;
};

it.effect("preserves nullable input paths across the entire registered catalog", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const allToolkits = { ...toolkits, screen: ScreenToolkit };
    const lost: Array<{ path: string; nullable: string }> = [];
    for (const entry of entries) {
      const tools: Record<string, Tool.Any> = allToolkits[entry.schemaRefs.toolkit].tools;
      const original = tools[entry.schemaRefs.tool];
      expect(original, entry.path).toBeDefined();
      const advertised = server.tools.find(({ tool }) => tool.name === listedToolName(entry));
      expect(advertised, entry.path).toBeDefined();
      const retained = nullablePaths(advertised!.tool.inputSchema);
      // A path that requires a key advertises it non-null on purpose; ToolAdmission refuses null.
      const requiredKey = "keyRequired" in entry && entry.keyRequired === true;
      for (const nullable of nullablePaths(Tool.getJsonSchema(original!)))
        if (
          !retained.has(nullable) &&
          !(requiredKey && nullable === "$.properties.clientRequestId")
        )
          lost.push({ path: entry.path, nullable });
    }
    expect(lost).toEqual([]);
  }).pipe(Effect.provide(registered)),
);

it.effect(
  "advertises provider clearing through HTTP listing and discovery and preserves null on both call routes",
  () => {
    const calls: Array<ProviderUpdateInput> = [];
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("schema-environment"),
      requestNamespace: "provider-schema",
      thread: undefined,
      client: { sessionId: "schema-client", label: "Schema test", access: "full-access" },
      capabilities: new Set(),
      issuedAt: 0,
    };
    const registrations = Layer.mergeAll(
      McpHttpServer.catalogRegistrations.provider,
      McpHttpServer.catalogRegistrations.agentSurface,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.mock(ProviderSettings.ProviderSettings)({
            manage: (request) =>
              Effect.sync(() => {
                if (request.action !== "update") throw new Error("Expected provider update");
                calls.push(request.input);
                return {
                  kind: "applied" as const,
                  action: "update" as const,
                  instance: null,
                  next: { call: "goat_provider_diagnose" },
                };
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const http = yield* serveOverHttp({ client: scope }, registrations);
      const listed = (yield* http.listTools("client")).find(
        ({ name }) => name === "goat_provider_update",
      );
      const described = yield* http.callTool("client", "goat_describe", {
        path: "provider.update",
        detail: "full",
      });
      expect(described.isError).toBe(false);
      expect(described.structuredContent).toMatchObject({
        entry: { inputSchema: listed?.inputSchema },
      });
      for (const field of ["displayName", "accentColor"])
        expect(nullablePaths(listed?.inputSchema)).toContain(`$.properties.${field}`);
      for (const route of ["direct", "goat_call"] as const) {
        const invoke = (args: Record<string, unknown>) =>
          route === "direct"
            ? http.callTool("client", "goat_provider_update", args)
            : http.callTool("client", "goat_call", { path: "provider.update", args });
        for (const args of [
          { instanceId: "codex" },
          { instanceId: "codex", displayName: "Custom", accentColor: "#123456" },
          { instanceId: "codex", displayName: null, accentColor: null },
        ]) {
          const result = yield* invoke(args);
          expect(result.isError, JSON.stringify(result)).toBe(false);
          if (route === "goat_call")
            expect(result.structuredContent).toMatchObject({ status: "ok" });
          expect(calls.at(-1)).toEqual(args);
        }
        const before = calls.length;
        for (const args of [
          { instanceId: "codex", displayName: 42 },
          { instanceId: "codex", accentColor: false },
          { instanceId: "codex", misspelledName: null },
        ]) {
          const result = yield* invoke(args);
          if (route === "direct") expect(result.isError).toBe(true);
          else
            expect(result.structuredContent).toMatchObject({
              status: "error",
              error: { code: "invalid_request" },
            });
        }
        expect(calls).toHaveLength(before);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Settings.ServerSettingsService)({
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, agentToolListing: "full" }),
          }),
          NodeHttpServer.layerTest,
        ),
      ),
    );
  },
);
