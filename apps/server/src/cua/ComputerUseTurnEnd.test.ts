import { assert, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { foregroundProxyLayer } from "./ComputerUseForeground.testkit.ts";
import { run } from "./ComputerUseLeases.projection.testkit.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as ComputerUseTurnEnd from "./ComputerUseTurnEnd.ts";

/** Only the fields the turn-end watch reads; the rest of a domain event does not matter here. */
const event = (type: string, status?: string) =>
  ({ type, payload: { status } }) as unknown as OrchestrationV2DomainEvent;

it.effect("a disable committed during startup revalidation is not missed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const disabled = yield* Deferred.make<void>();
      const changes = yield* PubSub.unbounded<Effect.Success<typeof settings.getSettings>>();
      let subscribed = false;
      const controlled = ServerSettings.ServerSettingsService.of({
        ...settings,
        getSettings: settings.getSettings.pipe(
          Effect.tap(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              subscribed = true;
            }),
          ),
          Effect.map(Stream.fromSubscription),
        ),
      });
      const layer = ComputerUseTurnEnd.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, controlled),
            Layer.mock(ComputerUseLeases.ComputerUseLeases)({
              disable: Deferred.succeed(disabled, undefined).pipe(Effect.asVoid),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
            Layer.mock(Handoffs.Handoffs)({
              stopComputerUseSessions: () => Effect.succeed([]),
              revalidateComputerUse: () => Effect.void,
            }),
          ),
        ),
      );
      const startup = yield* Layer.build(layer).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.isTrue(subscribed);
      const current = yield* settings.getSettings;
      yield* PubSub.publish(changes, { ...current, enableCua: false });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(startup);
      yield* Deferred.await(disabled);
    }),
  ).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest({ enableCua: true }))),
);

it.effect.each([
  ["only the run waits", false, true],
  ["its provider turn still runs, as while a person answers an approval", true, false],
] as const)(
  "a run that starts waiting after its provider turn's end was seen settles its control when %s",
  ([, turnRunning, idles]) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromQueue(events),
      });
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const thread = ThreadId.make(`thread:turn-end-${String(turnRunning)}`);
        const control = Option.getOrThrow(yield* leases.control(thread, Option.none()));
        // The provider turn's end was already handled while the run still ran; now it waits.
        yield* run(thread, `run:turn-end-${String(turnRunning)}`, 1, "waiting");
        if (turnRunning)
          yield* sql`
            INSERT INTO orchestration_v2_projection_provider_turns
              (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
            VALUES ('turn:approval', ${thread}, 'provider-thread', 'node', 1, 'running', '{}')`;
        const wakes = yield* leases.subscribe;
        yield* Queue.offer(events, event("run.updated", "waiting"));
        // Always publishes, after the event before it was handled.
        yield* Queue.offer(events, event("thread.runtime-mode-updated"));
        yield* PubSub.take(wakes);
        const listed = (yield* leases.sessions).find(
          (entry) => entry.control.controlId === control.controlId,
        );
        assert.equal(listed?.control.idle === true, idles);
      }).pipe(
        Effect.provide(
          ComputerUseTurnEnd.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                foregroundProxyLayer,
                orchestrator,
                Layer.mock(Handoffs.Handoffs)({
                  stopComputerUseSessions: () => Effect.succeed([]),
                  revalidateComputerUse: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      );
    }),
);
