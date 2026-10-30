import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type TurnItemId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect.each(["declined", "cancelled", "expired", "late-completed"] as const)(
  "a pending request that is %s retires prior mentions but accepts a new one",
  (action) =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const prior = yield* request({ apps: ["com.example.Other"] });
          if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
          yield* handoffs.respond(
            { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
            sessionId,
          );
          const pending = yield* request({ apps: ["com.example.Editor"], minutes: 5 });
          if (pending.kind !== "needs_human") return assert.fail("expected pending card");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`name-before-${action}`),
            threadId,
            messageId: MessageId.make(`message:name-before-${action}`),
            text: "Use com.example.Editor",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          if (action === "expired" || action === "late-completed") {
            yield* TestClock.adjust("5 minutes");
            if (action === "expired") yield* handoffs.sweep;
            else {
              const late = yield* handoffs
                .respond(
                  { threadId, handoffId: pending.handoff.handoffId, action: "completed" },
                  sessionId,
                )
                .pipe(Effect.result);
              assert.equal(late._tag, "Failure");
            }
          } else {
            yield* handoffs.respond(
              { threadId, handoffId: pending.handoff.handoffId, action },
              sessionId,
            );
          }
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`name-after-${action}`),
            threadId,
            messageId: MessageId.make(`message:name-after-${action}`),
            text: "Use com.example.Editor",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }),
      ),
    ),
);

it.effect("a failed decline transition still retires the earlier mention", () =>
  withHarness(({ orchestrator }) => {
    const failing = {
      ...orchestrator,
      dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
        command.type === "handoff.transition" && command.state === "declined"
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
        const prior = yield* request({ apps: ["com.example.Other"] });
        if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
        yield* handoffs.respond(
          { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
          sessionId,
        );
        const pending = yield* request({ apps: ["com.example.Editor"] });
        if (pending.kind !== "needs_human") return assert.fail("expected pending card");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("failed-decline-name"),
          threadId,
          messageId: MessageId.make("message:failed-decline-name"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const result = yield* handoffs
          .respond(
            { threadId, handoffId: pending.handoff.handoffId, action: "declined" },
            sessionId,
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    );
  }),
);

it.effect("declining a pending card ends an earlier automatic grant", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const prior = yield* request({ apps: ["com.example.Other"] });
        if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
        yield* handoffs.respond(
          { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
          sessionId,
        );
        const pending = yield* request({ apps: ["com.example.Editor"] });
        if (pending.kind !== "needs_human") return assert.fail("expected pending card");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("auto-before-decline"),
          threadId,
          messageId: MessageId.make("message:auto-before-decline"),
          text: "Use com.example.Automatic",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal((yield* request({ apps: ["com.example.Automatic"] })).kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        const grant = records.turnItems.find(
          (item) => item.type === "human_handoff" && item.handoff.computerUseScope === "standing",
        );
        if (grant?.type !== "human_handoff") return assert.fail("expected automatic grant");
        yield* handoffs.respond(
          { threadId, handoffId: pending.handoff.handoffId, action: "declined" },
          sessionId,
        );
        assert.equal((yield* leases.state(threadId, grant.handoff.handoffId))._tag, "ended");
      }),
    ),
  ),
);

it.effect("expiry while a request waits retires the earlier mention", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<TurnItemId>();
      yield* withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            const prior = yield* request({ apps: ["com.example.Other"] });
            if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
            yield* handoffs.respond(
              { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
              sessionId,
            );
            const runId = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
            yield* leases.control(threadId, Option.none(), runId);
            const waiting = yield* request(
              { apps: ["com.example.Editor"], minutes: 5 },
              Duration.minutes(10),
            ).pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(created);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("wait-expiry-name"),
              threadId,
              messageId: MessageId.make("message:wait-expiry-name"),
              text: "Use com.example.Editor",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* TestClock.adjust("5 minutes");
            assert.deepInclude(yield* Fiber.join(waiting), { kind: "refused", reason: "expired" });
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
          }),
        undefined,
        undefined,
        undefined,
        Option.none(),
        (command) =>
          command.type === "handoff.create" && command.handoff.apps?.includes("com.example.Editor")
            ? Deferred.succeed(created, command.handoff.handoffId).pipe(Effect.asVoid)
            : Effect.void,
      );
    }),
  ),
);
