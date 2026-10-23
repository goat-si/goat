import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpSchema } from "effect/ai";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { serveEnforcingCatalogOverHttp } from "./agentSurface.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const CALLER = ThreadId.make("thread:availability-caller");
const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
const resources = [...new Set(entries.map((entry) => entry.resource))];
const NOT_SERVED = "This GOAT server does not serve it.";

const callers: Readonly<Record<"thread" | "outside", McpInvocationScope>> = {
  thread: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: `provider:${CALLER}`,
    thread: {
      threadId: CALLER,
      providerSessionId: `provider:${CALLER}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration", "preview", "worktree", "device", "pull-requests"]),
    issuedAt: 0,
  },
  outside: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session",
    thread: undefined,
    client: { sessionId: "session", label: "GOAT SSH dispatch", access: "full-access" },
    capabilities: new Set(["orchestration", "preview", "worktree", "device", "pull-requests"]),
    issuedAt: 0,
  },
};

const seedCaller = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${CALLER}, 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-24', '2026-10-24', '{}')`,
  ),
);

interface Row {
  readonly path: string;
  readonly name: string;
  readonly available: { readonly now: boolean; readonly reason?: string };
}

type Http = Effect.Success<ReturnType<typeof serveEnforcingCatalogOverHttp>>;

const describeAll = Effect.fn(function* (http: Http, caller: "thread" | "outside") {
  const rows: Array<Row> = [];
  for (const resource of resources) {
    const result = yield* http.callTool(caller, "goat_describe", { path: resource });
    rows.push(...(result.structuredContent as { entries: ReadonlyArray<Row> }).entries);
  }
  return rows;
});

const textOf = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
// The call-time gate's own refusals (McpToolAccess.requireDeclaredCapability).
const refusedByProfile = (result: McpSchema.CallToolResult) =>
  result.isError === true &&
  /needs the goatclaw|declares no goatclaw capability/.test(textOf(result));

const enforcing = (goatclaw: { readonly enabled: boolean; readonly defaultProfile: string }) =>
  Layer.mergeAll(
    NodeHttpServer.layerTest,
    Sqlite.layerMemory,
    ServerSettings.layerTest({ goatclaw, agentToolListing: "full" }),
  );

it.effect.each(Object.keys(BUILTIN_PERMISSION_PROFILES))(
  "goat_describe and tools/list withhold exactly the tools a %s thread's profile refuses at call time",
  (id) =>
    Effect.gen(function* () {
      yield* seedCaller;
      const http = yield* serveEnforcingCatalogOverHttp(callers);
      const listed = new Set((yield* http.listTools("thread")).map((tool) => tool.name));
      const mismatches: Array<string> = [];
      let refused = 0;
      for (const row of yield* describeAll(http, "thread")) {
        if (row.available.reason === NOT_SERVED) continue;
        const entry = agentSurfaceRegistry[row.path as keyof typeof agentSurfaceRegistry];
        if (listed.has(row.name) !== row.available.now)
          mismatches.push(
            `${row.path}: listed ${listed.has(row.name)}, available ${row.available.now}`,
          );
        // Client-only tools are refused to every thread before any profile is consulted.
        if (entry.requires === "client") continue;
        // Arguments never decode for a caller the gate refuses, so empty ones reach it.
        const gated = refusedByProfile(yield* http.callTool("thread", row.name, {}));
        if (gated) refused += 1;
        if (row.available.now === gated)
          mismatches.push(`${row.path}: available ${row.available.now}, call refused ${gated}`);
        if (gated && !row.available.reason?.includes(`goatclaw ${entry.capability}`))
          mismatches.push(`${row.path}: reason ${row.available.reason}`);
      }
      expect(mismatches).toEqual([]);
      // Only the owner profile holds every capability a write declares.
      expect(refused > 0).toBe(id !== "owner");
    }).pipe(Effect.scoped, Effect.provide(enforcing({ enabled: true, defaultProfile: id }))),
);

it.effect("leaves outside clients bounded by their approved access, as the call gate does", () =>
  Effect.gen(function* () {
    yield* seedCaller;
    const http = yield* serveEnforcingCatalogOverHttp(callers);
    const write = entries.find(
      (entry) =>
        entry.effect !== "read" &&
        entry.requires === "either" &&
        entry.capability === "settings.write",
    )!;
    const asThread = (yield* describeAll(http, "thread")).find((row) => row.path === write.path)!;
    const asOutside = (yield* describeAll(http, "outside")).find((row) => row.path === write.path)!;
    expect(asThread.available).toEqual({
      now: false,
      reason: expect.stringContaining("goatclaw settings.write"),
    });
    expect(asOutside.available).toEqual({ now: true });
  }).pipe(Effect.scoped, Effect.provide(enforcing({ enabled: true, defaultProfile: "observer" }))),
);

it.effect(
  "reports why a thread whose profile no longer resolves cannot write, and keeps listing it",
  () =>
    Effect.gen(function* () {
      yield* seedCaller;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO goatclaw_thread_profiles (thread_id, profile_id, ceiling_json, owner_key)
      VALUES (${CALLER}, 'retired', '{}', 'test')`;
      const http = yield* serveEnforcingCatalogOverHttp(callers);
      const write = entries.find(
        (entry) =>
          entry.effect !== "read" &&
          entry.requires === "either" &&
          entry.capability === "settings.write",
      )!;
      const row = (yield* describeAll(http, "thread")).find(
        (candidate) => candidate.path === write.path,
      )!;
      expect(row.available).toEqual({
        now: false,
        reason: "Permission profile retired no longer exists.",
      });
      const call = yield* http.callTool("thread", row.name, {});
      expect(textOf(call)).toContain("Permission profile retired no longer exists.");
      // tools/list is cached for a session, so it never drops a tool over a refusal it cannot pin down.
      expect((yield* http.listTools("thread")).map((tool) => tool.name)).toContain(row.name);
    }).pipe(Effect.scoped, Effect.provide(enforcing({ enabled: true, defaultProfile: "owner" }))),
);
