import { assert, it } from "@effect/vitest";
import { CommandId, GuestMessageId, GuestShareId, MessageId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { applyPatch } from "./ComputerUseSettings.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("a forwarded guest message cannot name an app for automatic approval", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const shareId = GuestShareId.make("share:cu-guest");
      const guestMessageId = GuestMessageId.make("guest-message:cu");
      yield* orchestrator.dispatch({
        type: "thread.guest-share.open",
        commandId: CommandId.make("guest-open"),
        threadId,
        shareId,
        host: "example.test",
        expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 })),
      });
      yield* orchestrator.dispatch({
        type: "thread.guest-share.redeem",
        commandId: CommandId.make("guest-redeem"),
        threadId,
        shareId,
        guestName: "Guest",
      });
      yield* orchestrator.dispatch({
        type: "thread.guest-message.submit",
        commandId: CommandId.make("guest-submit"),
        threadId,
        shareId,
        guestMessageId,
        text: "Use com.example.Editor",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("guest-forward"),
        threadId,
        messageId: MessageId.make("message:guest-forward"),
        guestMessageId,
        text: "",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect.each(["live", "expired"] as const)(
  "removing an always choice after its %s lease retires old mentions",
  (state) =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("removal-named"),
          threadId,
          messageId: MessageId.make("message:removal-named"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
            if (state === "expired") yield* TestClock.adjust("31 minutes");
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* applyPatch(
              handoffs,
              { cuaAllowedApps: [] },
              settings.updateSettings({ cuaAllowedApps: [] }),
              "test",
            );
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
          }),
        );
      }),
    ),
);

it.effect("a direct settings writer cannot revive a removed app from an old mention", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("direct-named"),
        threadId,
        messageId: MessageId.make("message:direct-named"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect("a failed end transition cannot leave the session reusable", () =>
  withHarness(({ orchestrator }) => {
    const failing = {
      ...orchestrator,
      dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
        command.type === "handoff.transition" && command.state === "cancelled"
          ? Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "injected",
              }),
            )
          : orchestrator.dispatch(command),
    };
    return withRequests(failing, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* handoffs
          .respond({ threadId, handoffId: first.handoff.handoffId, action: "cancelled" }, sessionId)
          .pipe(Effect.result);
        yield* TestClock.adjust("31 minutes");
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    );
  }),
);
