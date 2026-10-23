import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Handoffs from "./Handoffs.ts";

const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Handoff)));
const threadId = ThreadId.make("thread:authority");
const handoffId = TurnItemId.make("handoff:authority");
const sessionId = AuthSessionId.make("session:authority");
const now = DateTime.makeUnsafe("2026-10-23T00:00:00Z");
const address = { threadId, handoffId };

// A session that holds every scope an orchestration:operate handoff needs; only its subject varies.
const session = (subject: string): AuthClientSession => ({
  sessionId,
  subject,
  method: "bearer-access-token",
  scopes: ["orchestration:operate"],
  client: { label: "Client", deviceType: "unknown" },
  issuedAt: now,
  expiresAt: DateTime.add(now, { days: 1 }),
  lastConnectedAt: now,
  connected: true,
  current: true,
});

const run = <A, E>(
  subject: string,
  body: (service: Handoffs.Handoffs["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const answered = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const handoff = yield* encodeHandoff({
        handoffId,
        kind: "approval",
        title: "Approve",
        reason: "A person decides.",
        requestedBy: { threadId, providerInstanceId: ProviderInstanceId.make("codex"), path: "x" },
        target: { environmentId: EnvironmentId.make("test"), path: "example.approve" },
        dedupeKey: "key",
        state: "pending",
        expiresAt: null,
        createdAt: now,
        actor: { type: "agent", threadId },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${handoffId}, ${threadId}, 0, 'human_handoff', 'waiting', '2026-10-23T00:00:00.000Z',
        json_object('handoff', json(${handoff})))`;
      return yield* body(yield* Handoffs.Handoffs).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        Handoffs.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "test",
                legacyCookieName: undefined,
                listActive: () => Effect.succeed([session(subject)]),
              }),
              Layer.mock(SecretRequests.SecretRequests)({
                answer: () => Ref.update(answered, (count) => count + 1),
              }),
              Layer.mock(SecretStore.ServerSecretStore)({
                get: () => Effect.succeed(Option.none()),
                remove: () => Effect.void,
                getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(1)),
              }),
              Layer.unwrap(
                Effect.map(SqlClient.SqlClient, (sql) =>
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    // Applies the transition to the projection the service reads back.
                    dispatch: (command) =>
                      (command.type === "handoff.transition"
                        ? sql`UPDATE orchestration_v2_projection_turn_items
                            SET payload_json = json_set(payload_json, '$.handoff.state', ${command.state})`
                        : Effect.void
                      ).pipe(Effect.as({ sequence: 1, storedEvents: [] }), Effect.orDie),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    return { result, answered: yield* Ref.get(answered) };
  });

const secretAnswer = { threadId, turnItemId: handoffId, answer: { type: "decline" as const } };

it.effect("refuses an MCP client session that holds a person's scopes", () =>
  Effect.gen(function* () {
    const responded = yield* run("mcp-client", (service) =>
      service.respond({ ...address, action: "declined" }, sessionId),
    );
    expect(responded.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EnvironmentAuthorizationError" },
    });
    const secret = yield* run("mcp-client", (service) =>
      service.answerSecret(secretAnswer, sessionId),
    );
    expect(secret.result).toMatchObject({ _tag: "Failure" });
    expect(secret.answered).toBe(0);
  }),
);

it.effect("lets the owning desktop's bootstrap session respond and answer secrets", () =>
  Effect.gen(function* () {
    const responded = yield* run("desktop-bootstrap", (service) =>
      service.respond({ ...address, action: "declined" }, sessionId),
    );
    expect(responded.result).toMatchObject({ _tag: "Success", success: { state: "declined" } });
    const secret = yield* run("desktop-bootstrap", (service) =>
      service.answerSecret(secretAnswer, sessionId),
    );
    expect(secret.result).toMatchObject({ _tag: "Success" });
    expect(secret.answered).toBe(1);
  }),
);
