import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { instanceId, threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { stopAllComputerUse, stopComputerUse } from "./ComputerUseRpcHandlers.ts";
import {
  requestWithHandoffs,
  sessionId,
  supported,
  withRequests,
} from "./ComputerUseRequests.testkit.ts";

it.effect("session approval renews an expired lease without a pending approval", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
        yield* TestClock.adjust("31 minutes");
        const renewed = yield* request({ apps: ["COM.EXAMPLE.EDITOR"] });
        assert.equal(renewed.kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        const cards = records.turnItems.filter((item) => item.type === "human_handoff");
        assert.equal(cards.length, 2);
        assert.isTrue(
          cards.every(
            (item) => item.type === "human_handoff" && item.handoff.state === "completed",
          ),
        );
      }),
    ),
  ),
);

it.effect("a session choice survives restarting the handoff service", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
        }),
      );
      yield* TestClock.adjust("31 minutes");
      yield* withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }),
      );
    }),
  ),
);

it.effect("ending a session admission requires another approval", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        const address = { threadId, handoffId: first.handoff.handoffId };
        yield* handoffs.respond(
          { ...address, action: "completed", computerUseScope: "session" },
          sessionId,
        );
        yield* handoffs.respond({ ...address, action: "cancelled" }, sessionId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("Stop clears a session even after its lease expires", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
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
        yield* TestClock.adjust("31 minutes");
        yield* stopComputerUse(Option.some(leases), handoffs, sessionId, threadId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("Stop all clears session choices without active leases", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
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
        yield* TestClock.adjust("31 minutes");
        yield* stopAllComputerUse(Option.some(leases), handoffs, sessionId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect(
  "turning computer use off clears sessions while enabling an already enabled host does not",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ enableCua: true });
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
          yield* handoffs.withComputerUseToggle(true, settings.updateSettings({ enableCua: true }));
          yield* TestClock.adjust("31 minutes");
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          yield* handoffs.withComputerUseToggle(
            false,
            settings.updateSettings({ enableCua: false }),
          );
          yield* handoffs.withComputerUseToggle(true, settings.updateSettings({ enableCua: true }));
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      ),
    ),
);

it.effect("a session choice does not approve the same app in another thread", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const other = ThreadId.make("thread:session-other");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("session-other-create"),
        threadId: other,
        projectId: ProjectId.make("project:handoff-tests"),
        title: "Other",
        modelSelection: { instanceId, model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("session-other-message"),
        threadId: other,
        messageId: MessageId.make("message:session-other"),
        text: "Use the app",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
          yield* TestClock.adjust("31 minutes");
          const otherResult = yield* requestWithHandoffs(
            handoffs,
            other,
          )({ apps: ["com.example.Editor"] });
          assert.equal(otherResult.kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect("always approval renews without a card until removed in settings", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
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
        yield* TestClock.adjust("31 minutes");
        assert.equal((yield* request({ apps: ["COM.EXAMPLE.EDITOR"] })).kind, "available");
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaAllowedApps: [] });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("removing an always choice ends its current admission", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
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
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({ cuaAllowedApps: [] });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        assert.equal((yield* leases.state(threadId, first.handoff.handoffId))._tag, "ended");
      }),
    ),
  ),
);

it.effect("Stop does not remove an always choice", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
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
        yield* stopComputerUse(Option.some(leases), handoffs, sessionId, threadId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
      }),
    ),
  ),
);

it.effect("a concurrent re-enable cannot revive a session ended by turning computer use off", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ enableCua: true });
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
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const off = yield* handoffs
          .withComputerUseToggle(
            false,
            Effect.gen(function* () {
              yield* settings.updateSettings({ enableCua: false });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const on = yield* handoffs
          .withComputerUseToggle(true, settings.updateSettings({ enableCua: true }))
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(off);
        yield* Fiber.join(on);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect(
  "removal waits for an in-flight automatic grant and ends it before the next request",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* withRequests(
          orchestrator,
          supported,
          ({ request }) =>
            Effect.gen(function* () {
              const settings = yield* ServerSettings.ServerSettingsService;
              yield* settings.updateSettings({ cuaAllowedApps: ["com.example.Editor"] });
              const first = yield* request({ apps: ["com.example.Editor"] }).pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              const remove = yield* settings
                .updateSettings({ cuaAllowedApps: [] })
                .pipe(Effect.forkChild);
              yield* Deferred.succeed(release, undefined);
              assert.equal((yield* Fiber.join(first)).kind, "available");
              yield* Fiber.join(remove);
              assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
            }),
          undefined,
          undefined,
          undefined,
          undefined,
          (command) =>
            command.type === "handoff.create" && command.handoff.state === "completed"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        );
      }),
    ),
);
