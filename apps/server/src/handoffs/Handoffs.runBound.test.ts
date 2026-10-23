import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
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
const threadId = ThreadId.make("thread:run-bound");

// A request_secret card from a run with the given status, an hour before its own clock expiry.
const seedCard = (id: string, runStatus: "running" | "completed") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const handoff = yield* encodeHandoff({
      handoffId: TurnItemId.make(id),
      kind: "secret",
      title: "Webhook secret",
      reason: "Signs the posts.",
      requestedBy: { threadId, providerInstanceId: ProviderInstanceId.make("codex"), path: "x" },
      target: { environmentId: EnvironmentId.make("test"), path: "secret.consume" },
      dedupeKey: id,
      state: "pending",
      expiresAt: DateTime.add(now, { hours: 1 }),
      createdAt: now,
      actor: { type: "agent", threadId },
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run:${id}`}, ${threadId}, ${id.length}, 'codex', ${runStatus}, '2026-10-23', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${`run:${id}`}, 0, 'secret_request', 'waiting', '2026-10-23',
      json_object('handoff', json(${handoff})))`;
  });

it.effect("expires a waiting secret card once its run ended, and leaves a live run's card", () =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    yield* Effect.gen(function* () {
      yield* seedCard("handoff:ended", "completed");
      yield* seedCard("handoff:live", "running");
      yield* (yield* Handoffs.Handoffs).sweep.pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        Handoffs.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "test",
                legacyCookieName: undefined,
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(SecretStore.ServerSecretStore)({
                get: () => Effect.succeed(Option.none()),
                remove: () => Effect.void,
                getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(1)),
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                dispatch: (command) =>
                  Ref.update(commands, (all) => [...all, command]).pipe(
                    Effect.as({ sequence: 1, storedEvents: [] }),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    expect(yield* Ref.get(commands)).toMatchObject([
      { type: "handoff.transition", handoffId: "handoff:ended", state: "expired" },
    ]);
  }),
);
