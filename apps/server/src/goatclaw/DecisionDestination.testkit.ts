import { EnvironmentId, type PermissionProfile } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { DecisionCaller } from "./DecisionInbox.ts";

export const origin = EnvironmentId.make("origin");
export const transport = {
  kind: "agent",
  scope: {
    environmentId: EnvironmentId.make("test"),
    issuedAt: 0,
    requestNamespace: "transport",
    capabilities: new Set(["orchestration"] as const),
    thread: undefined,
    client: { sessionId: "remote-session", label: "Remote manager", access: "full-access" },
  },
} satisfies DecisionCaller;

export const narrowCeiling: PermissionProfile = {
  id: "manager",
  capabilities: ["threads.launch"],
  runtimeModeCeiling: "auto",
  maxLanes: 1,
};

/** Real projection rows expose SQL filtering defects, including rows preceding eligible results. */
export const seedDestination = (input: {
  id: string;
  launcherEnvironmentId?: string;
  launcherThreadId?: string;
  deleted?: boolean;
  archived?: boolean;
  providerNative?: boolean;
  pending?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      ...(input.launcherEnvironmentId === undefined
        ? {}
        : {
            launchedBy: {
              environmentId: input.launcherEnvironmentId,
              threadId: input.launcherThreadId ?? "manager-a",
            },
          }),
      ...(input.providerNative
        ? { creationSource: "provider", lineage: { relationshipToParent: "subagent" } }
        : {}),
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, archived_at, payload_json)
    VALUES (${input.id}, 'project', ${input.id}, 'codex', 'auto', 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', ${input.deleted ? "1970-01-01T00:00:00.000Z" : null}, ${input.archived ? "1970-01-01T00:00:00.000Z" : null}, ${payload})`;
    yield* sql`INSERT INTO decision_items
    (id, from_thread_id, title, context, options_json, required_profile, status, created_at, updated_at)
    VALUES (${`decision:${input.id}`}, ${input.id}, ${input.id}, '', '[{"id":"wait","label":"Wait","consequence":"Paused"}]', 'worker', 'open', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
    if (input.pending !== false) {
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES (${`question-${input.id}`}, ${input.id}, 'node', 'user_input', 'pending', '1970-01-01T00:00:00.000Z', '{}')`;
    }
  });
