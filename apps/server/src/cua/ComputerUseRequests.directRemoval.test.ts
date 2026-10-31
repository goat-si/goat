import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type ServerSettings as Settings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("a published removal revokes a live grant and retires its old mention", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<Settings>();
      const revoked = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const base = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...base,
            updateSettings: (patch, authorize) =>
              base
                .updateSettings(patch, authorize)
                .pipe(Effect.tap((next) => PubSub.publish(changes, next))),
            updateSettingsWith: (patchFor, authorize) =>
              base
                .updateSettingsWith(patchFor, authorize)
                .pipe(Effect.tap((next) => PubSub.publish(changes, next))),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableCua: true })));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("direct-old-mention"),
        threadId,
        messageId: MessageId.make("message:direct-old-mention"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            const first = yield* request({ apps: ["com.example.Editor"] });
            if (first.kind !== "needs_human") return assert.fail("expected approval");
            yield* handoffs.respond(
              {
                threadId,
                handoffId: first.handoff.handoffId,
                action: "completed",
                computerUseScope: "always",
              },
              sessionId,
            );
            yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
              cuaAllowedApps: [],
            });
            yield* Deferred.await(revoked);
            assert.equal((yield* leases.state(threadId, first.handoff.handoffId))._tag, "ended");
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
          }),
        undefined,
        undefined,
        undefined,
        undefined,
        (command) =>
          command.type === "handoff.transition" && command.state === "cancelled"
            ? Deferred.succeed(revoked, undefined).pipe(Effect.asVoid)
            : Effect.void,
        undefined,
        undefined,
        undefined,
        settingsLayer,
      );
    }),
  ),
);
