import { assert } from "@effect/vitest";
import * as M from "@goat/contracts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import * as Hold from "./MemoryGenerationHold.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";
import {
  conflict,
  fixture,
  id,
  member,
  peer,
  ready,
  realGeneration,
} from "./MemorySyncService.testkit.ts";

export const fencedReleaseAfterSync = () =>
  Effect.gen(function* () {
    const afterSync = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<Store.TicketRow>();
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.fail(
          new M.TextGenerationError({
            operation: "resolveMemoryConflict",
            detail: "Grok did not disclose or support the selected memory model.",
            cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
          }),
        ),
    });
    const client = peer({
      // Settings moved to another Hub binding, so the client fences locally: the old lease
      // may still be live at the Hub, and the attempt must not be retired on that answer.
      release: () =>
        Deferred.await(afterSync).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const transitions = Option.getOrThrow(
                yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
              );
              yield* transitions.applyMemoryHubTransition(
                {
                  requestId: M.MemoryOperationId.make(id(9001)),
                  expectedVersion: 1,
                  settings: { ...member, secretName: "rebound-fixture" },
                },
                Effect.void,
              );
            }),
          ),
          Effect.orDie,
          Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "fenced" }))),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const store = yield* Store.MemoryStore;
        const observed = Store.MemoryStore.of({
          ...store,
          transitionResolutionTicketTx: (input) =>
            store
              .transitionResolutionTicketTx(input)
              .pipe(
                Effect.tap((result) =>
                  result !== null &&
                  (input.nextState === "recoverable" || input.nextState === "terminal")
                    ? Deferred.succeed(settled, result)
                    : Effect.void,
                ),
              ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce;
            yield* Deferred.succeed(afterSync, undefined);
            yield* sync.scheduleConflictResolution;
            const applied = yield* Deferred.await(settled);
            assert.isNotNull(applied);
            assert.strictEqual(applied.state, "recoverable");
            const sql = yield* SqlClient.SqlClient;
            const tickets = yield* sql<{
              state: string;
            }>`SELECT json_extract(ticket_json,'$.state') AS state FROM memory_outbox WHERE kind='resolve'`;
            assert.strictEqual(tickets.length, 1);
            assert.strictEqual(tickets[0]?.state, "recoverable");
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, observed)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(client, model).pipe(Layer.provideMerge(Hold.layer)))),
    );
  });
