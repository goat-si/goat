import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Profiles from "./PermissionProfiles.ts";
import * as Settings from "../serverSettings.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Inbox from "./DecisionInbox.ts";
import { EnvironmentId, type PermissionProfile } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { DecisionCaller } from "./DecisionInbox.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
    const payload = yield* encodeJson({
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

export const seedThread = (id = "asking", mode = "full-access") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${id}, 'project', 'Asking thread', 'codex', ${mode}, 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '{}')`;
  });
export const seedPending = (kind = "user_input", mode = "full-access") =>
  Effect.gen(function* () {
    yield* seedThread("pending-thread", mode);
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodeJson(
      kind === "user_input"
        ? {
            requestId: "question",
            questions: [
              {
                id: "q",
                header: "Placement",
                question: "Where should work run?",
                options: [{ label: "Wait", description: "Keep paused" }],
              },
            ],
          }
        : { requestId: "question", prompt: "Allow the command?" },
    );
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
    VALUES ('question', 'pending-thread', 'node', ${kind}, 'pending', '1970-01-01T00:00:00.000Z', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('item', 'pending-thread', 0, ${kind === "user_input" ? "user_input_request" : "approval_request"}, 'pending', '1970-01-01T00:00:00.000Z', ${payload})`;
  });

export const fixture = (
  options: {
    readonly profile?: string;
    readonly threads?: Layer.Layer<ThreadManagement.ThreadManagementService>;
    readonly pending?: Layer.Layer<
      PendingQuestions.PendingQuestionsMcpService,
      never,
      SqlClient.SqlClient
    >;
  } = {},
) =>
  Inbox.layer.pipe(
    Layer.provide(Profiles.layer),
    Layer.provide(options.threads ?? Layer.mock(ThreadManagement.ThreadManagementService)({})),
    Layer.provide(options.pending ?? Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
    Layer.provideMerge(
      Settings.layerTest({
        goatclaw: { enabled: true, defaultProfile: options.profile ?? "worker" },
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );
export const pendingUsingSql = (
  respond: (
    sql: SqlClient.SqlClient,
  ) => PendingQuestions.PendingQuestionsMcpService["Service"]["respond"],
) =>
  Layer.unwrap(
    Effect.map(SqlClient.SqlClient, (sql) =>
      Layer.mock(PendingQuestions.PendingQuestionsMcpService)({ respond: respond(sql) }),
    ),
  );
