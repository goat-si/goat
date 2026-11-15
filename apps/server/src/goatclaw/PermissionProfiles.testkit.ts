import { EnvironmentId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { layer } from "./PermissionProfiles.ts";

export const outside: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "profiles",
  thread: undefined,
  client: { sessionId: "profiles", label: "test", access: "full-access" },
};
export const threadScope = (id: string): McpInvocationScope => ({
  ...outside,
  client: undefined,
  thread: {
    threadId: ThreadId.make(id),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});
export const fixture = (profile = "worker", enabled = true) =>
  layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({ goatclaw: { enabled, defaultProfile: profile } }),
    ),
  );
export const seed = (id: string, mode: RuntimeMode = "full-access") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${id}, 'project', 'Test', 'codex', ${mode}, 'default', '2026-10-21', '2026-10-21', '{}')`;
  });
