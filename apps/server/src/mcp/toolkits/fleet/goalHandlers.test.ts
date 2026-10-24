import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, FleetGoalId, GoatGoalApplyInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as McpClientAuthority from "../../../auth/McpClientAuthority.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { GoalRecovery } from "../../../fleet/goals/GoalRecovery.ts";
import * as GoalService from "../../../fleet/goals/GoalService.ts";
import * as GoalStore from "../../../fleet/goals/GoalStore.ts";
import { testSpec } from "../../../fleet/goals/goalTestkit.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { serveCatalogOverHttp } from "../../agentSurface.testkit.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const GOAL_TOOLS = [
  "goat_goal_apply",
  "goat_goal_delete",
  "goat_goal_get",
  "goat_goal_list",
  "goat_goal_pause",
  "goat_goal_resume",
];

/** The fleet tools and goat_call/goat_describe, over the real goal service and store. */
const served = Layer.mergeAll(
  McpHttpServer.catalogRegistrations.fleet,
  McpHttpServer.catalogRegistrations.agentSurface,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    GoalService.layer.pipe(
      Layer.provide(
        Layer.succeed(McpClientAuthority.McpClientAuthority, {
          load: (sessionId) =>
            Effect.succeed(
              sessionId.startsWith("session:")
                ? {
                    sessionId: AuthSessionId.make(sessionId),
                    grantedScopes: ["orchestration:operate" as const],
                    reauthorize: () => Effect.void,
                  }
                : { unavailable: "The MCP client session was revoked or has expired." },
            ),
        }),
      ),
      Layer.provide(
        Layer.succeed(GoalRecovery, {
          capture: () => Effect.void,
          resume: () => Effect.die("unused"),
          forget: () => Effect.void,
        }),
      ),
      Layer.provide(GoalStore.layer),
      Layer.provide(NodeCrypto.layer),
    ),
  ),
  // goat_call signs operation handles with the server's key.
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
    }),
  ),
  Layer.provideMerge(Profiles.layer),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest({ goatclaw: { enabled: false } })),
);

const client = (
  sessionId: string,
  access: "read-only" | "full-access" = "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:" + sessionId,
  thread: undefined,
  client: { sessionId, label: "bot", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "goal-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goal-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** One tool call as `as`; the answer as the caller reads it, unwrapped from goat_call's envelope. */
const call = (
  as: McpInvocationContext.McpInvocationScope,
  route: "direct" | "goat_call",
  tool: string,
  args: object,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      route === "direct"
        ? server.callTool({ name: tool, arguments: args })
        : server.callTool({ name: "goat_call", arguments: { path: pathOf[tool], args } }),
    ),
    Effect.map((result) => {
      if (route === "goat_call") {
        const envelope = result.structuredContent as {
          readonly status: string;
          readonly value?: unknown;
          readonly error?: { readonly reason: string };
        };
        return envelope.status === "ok"
          ? { ok: true as const, value: envelope.value as Record<string, unknown> }
          : { ok: false as const, code: envelope.error?.reason ?? "" };
      }
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const body = decodeJson(text) as Record<string, unknown>;
      return result.isError === true
        ? { ok: false as const, code: String(body["code"]) }
        : { ok: true as const, value: body };
    }),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, as),
  );

const pathOf: Record<string, string> = {
  goat_goal_apply: "goal.apply",
  goat_goal_get: "goal.get",
  goat_goal_list: "goal.list",
  goat_goal_pause: "goal.pause",
  goat_goal_resume: "goal.resume",
  goat_goal_delete: "goal.delete",
};

const spec = testSpec({ workers: { ...testSpec().workers, runtimeMode: "auto-accept-edits" } });
const encodeApply = Schema.encodeSync(Schema.toCodecJson(GoatGoalApplyInput));
/** Arguments as an MCP client sends them: the input encoded to JSON. */
const applyInput = (overrides: Partial<GoatGoalApplyInput> = {}) =>
  encodeApply({ title: "Ship", spec, ...overrides }) as object;

const valueOf = <T extends { readonly ok: boolean }>(result: T) => {
  if (!result.ok) throw new Error("expected success, got " + JSON.stringify(result));
  return (result as unknown as { readonly value: Record<string, unknown> }).value;
};

describe("goal tools for an outside MCP client (#493)", () => {
  it.effect.each(["direct", "goat_call"] as const)(
    "declares, reads, updates, pauses, resumes and deletes its own goal (%s)",
    (route) =>
      Effect.gen(function* () {
        const bot = client("session:bot");
        const created = valueOf(yield* call(bot, route, "goat_goal_apply", applyInput()));
        const goal = created["goal"] as { readonly id: string; readonly owner: unknown };
        expect(goal.owner).toEqual({
          kind: "mcp_client",
          threadId: null,
          mcpOwner: "client:session:bot",
          runtimeModeCeiling: "full-access",
        });
        const id = FleetGoalId.make(goal.id);
        expect(valueOf(yield* call(bot, route, "goat_goal_get", { id }))).toMatchObject({
          goal: { id },
        });
        expect(valueOf(yield* call(bot, route, "goat_goal_list", {}))).toMatchObject({
          goals: [{ id }],
        });
        expect(
          valueOf(yield* call(bot, route, "goat_goal_apply", applyInput({ id, title: "Ship v2" }))),
        ).toMatchObject({ changed: true, goal: { generation: 2 } });
        expect(valueOf(yield* call(bot, route, "goat_goal_pause", { id }))).toMatchObject({
          goal: { spec: { paused: true } },
        });
        expect(valueOf(yield* call(bot, route, "goat_goal_resume", { id }))).toMatchObject({
          goal: { spec: { paused: false } },
        });

        // Another client with full access reaches none of it.
        const other = client("session:other");
        for (const [tool, args] of [
          ["goat_goal_get", { id }],
          ["goat_goal_pause", { id }],
          ["goat_goal_delete", { id, force: true }],
          ["goat_goal_apply", applyInput({ id, title: "Mine" })],
        ] as const)
          expect(yield* call(other, route, tool, args), tool).toMatchObject({
            ok: false,
            code: "not_found",
          });
        expect(valueOf(yield* call(other, route, "goat_goal_list", {}))).toMatchObject({
          goals: [],
        });
        // A read-only client is refused before anything changes.
        expect(
          yield* call(client("session:bot", "read-only"), route, "goat_goal_pause", { id }),
        ).toMatchObject({ ok: false });

        expect(
          valueOf(yield* call(bot, route, "goat_goal_delete", { id, force: true })),
        ).toMatchObject({ deleted: true });
        expect(yield* call(bot, route, "goat_goal_get", { id })).toMatchObject({
          ok: false,
          code: "not_found",
        });
      }).pipe(Effect.provide(served)),
  );

  it.effect("shows the goal tools to the client in goat_describe", () =>
    Effect.gen(function* () {
      for (const path of Object.values(pathOf)) {
        const described = yield* McpServer.McpServer.pipe(
          Effect.flatMap((server) =>
            server.callTool({ name: "goat_describe", arguments: { path } }),
          ),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.provideService(McpInvocationContext.McpInvocationContext, client("session:bot")),
        );
        const text = described.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        expect(
          (decodeJson(text) as { entry: { available: unknown } }).entry.available,
          path,
        ).toEqual({ now: true });
      }
    }).pipe(Effect.provide(served)),
  );
});

it.effect("lists the goal tools to an outside client in the full listing", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp({ client: client("session:bot") }, "full");
    const listed = (yield* http.listTools("client")).map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(GOAL_TOOLS));
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
