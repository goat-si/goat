import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ServerSettingsError,
  type ServerSettings as Settings,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("a failed settings observer cannot reuse a mention after an unseen removal", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<Settings>();
      const failed = yield* Deferred.make<void>();
      const restarted = yield* Deferred.make<void>();
      const didFail = yield* Ref.make(false);
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const base = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...base,
            getSettings: base.getSettings.pipe(
              Effect.tap(() =>
                Ref.get(didFail).pipe(
                  Effect.flatMap((failedOnce) =>
                    failedOnce
                      ? Deferred.succeed(restarted, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
            ),
            updateSettings: (patch, authorize) =>
              base
                .updateSettings(patch, authorize)
                .pipe(Effect.tap((next) => PubSub.publish(changes, next))),
            subscribeChanges: PubSub.subscribe(changes).pipe(
              Effect.map((subscription) =>
                Stream.fromSubscription(subscription).pipe(
                  Stream.mapEffect((snapshot) =>
                    Effect.gen(function* () {
                      if (
                        snapshot.cuaAllowedApps.length > 0 &&
                        !(yield* Ref.getAndSet(didFail, true))
                      ) {
                        yield* Deferred.succeed(failed, undefined);
                        return yield* new ServerSettingsError({
                          settingsPath: "test",
                          operation: "read-file",
                        });
                      }
                      return snapshot;
                    }),
                  ),
                  Stream.orDie,
                ),
              ),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableCua: true })));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("unobserved-named"),
        threadId,
        messageId: MessageId.make("message:unobserved-named"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(
        orchestrator,
        supported,
        ({ request, handoffs }) =>
          Effect.gen(function* () {
            const first = yield* request({ apps: ["com.example.Other"] });
            if (first.kind !== "needs_human") return assert.fail("expected approval");
            yield* handoffs.respond(
              { threadId, handoffId: first.handoff.handoffId, action: "completed" },
              sessionId,
            );
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* settings.updateSettings({ cuaAllowedApps: ["com.example.Editor"] });
            yield* Deferred.await(failed);
            yield* settings.updateSettings({ cuaAllowedApps: [] });
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(restarted);
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
          }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        settingsLayer,
      );
    }),
  ),
);
