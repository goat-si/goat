import { assert, it, vi } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import { storeName } from "../handoffs/handoffDigest.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect.each([
  { expired: false, failRemoval: false, title: "preserves newer named-app consent" },
  {
    expired: true,
    failRemoval: false,
    title: "retires newer named-app consent when the card expires",
  },
  { expired: true, failRemoval: true, title: "retires consent if expired payload removal fails" },
])("opening an older pending card $title", ({ expired, failRemoval }) =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases, store }) =>
      Effect.gen(function* () {
        const prior = yield* request({ apps: ["com.example.Other"] });
        if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
        yield* handoffs.respond(
          { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
          sessionId,
        );
        const pending = yield* request({ apps: ["com.example.Editor"] });
        if (pending.kind !== "needs_human") return assert.fail("expected pending card");
        if (expired) yield* TestClock.adjust("10 minutes");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("open-card-named"),
          threadId,
          messageId: MessageId.make("message:open-card-named"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        const automatic = records.turnItems.find(
          (item) => item.type === "human_handoff" && item.handoff.computerUseScope === "standing",
        );
        if (automatic?.type !== "human_handoff") return assert.fail("expected automatic grant");
        const address = { threadId, handoffId: pending.handoff.handoffId };
        if (expired) {
          yield* TestClock.adjust("21 minutes");
          const remove = store.remove;
          using spy = vi
            .spyOn(store, "remove")
            .mockImplementation((name) =>
              failRemoval && name === storeName(address.handoffId)
                ? Effect.fail(
                    new SecretStore.SecretStoreRemoveError({ resource: name, cause: "test" }),
                  )
                : remove(name),
            );
          const error = yield* handoffs.open(address, sessionId).pipe(Effect.flip);
          if (error._tag !== "HandoffError") return assert.fail("expected handoff error");
          assert.equal(error.reason, failRemoval ? "unavailable" : "expired");
          if (failRemoval) assert.equal(spy.mock.calls.length, 1);
          assert.equal((yield* handoffs.read(address)).state, "expired");
          assert.equal((yield* leases.state(threadId, automatic.handoff.handoffId))._tag, "ended");
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        } else {
          const opened = yield* handoffs.open(address, sessionId);
          assert.equal(opened.handoff.state, "opened");
          assert.notEqual(
            (yield* leases.state(threadId, automatic.handoff.handoffId))._tag,
            "ended",
          );
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }
      }),
    ),
  ),
);

it.effect("a later automatic grant cannot outlive Stop of its earlier naming consent", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("before-stop-named"),
        threadId,
        messageId: MessageId.make("message:before-stop-named"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const prior = yield* request({ apps: ["com.example.Other"] });
          if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
          yield* handoffs.respond(
            { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
            sessionId,
          );
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            sequence: number;
          }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
          const cutoff = rows[0]?.sequence ?? 0;
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          yield* handoffs.stopComputerUseSessions(threadId, cutoff);
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect(
  "ending a session revokes an older standing grant even if the always choice remains",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.A"] });
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
          assert.equal((yield* request({ apps: ["com.example.A"] })).kind, "available");
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          const standing = records.turnItems.find(
            (item) => item.type === "human_handoff" && item.handoff.computerUseScope === "standing",
          );
          if (standing?.type !== "human_handoff") return assert.fail("expected standing grant");
          const second = yield* request({ apps: ["com.example.B"] });
          if (second.kind !== "needs_human") return assert.fail("expected second approval");
          yield* handoffs.respond(
            {
              threadId,
              handoffId: second.handoff.handoffId,
              action: "completed",
              computerUseScope: "session",
            },
            sessionId,
          );
          yield* handoffs.respond(
            { threadId, handoffId: second.handoff.handoffId, action: "cancelled" },
            sessionId,
          );
          assert.equal((yield* leases.state(threadId, standing.handoff.handoffId))._tag, "ended");
        }),
      ),
    ),
);

it.effect("Stop removes a named grant created after the stop commit", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Handoffs.Handoffs["Service"]>();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withHarness(
      ({ orchestrator, worker }) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("race-named"),
            threadId,
            messageId: MessageId.make("message:race-named"),
            text: "Use com.example.Editor",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const intercepted = {
            ...orchestrator,
            dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
              command.type === "handoff.create" && command.handoff.state === "completed"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(orchestrator.dispatch(command)),
                  )
                : orchestrator.dispatch(command),
          };
          yield* withRequests(intercepted, supported, ({ request, handoffs }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, handoffs);
              const prior = yield* request({ apps: ["com.example.Other"] });
              if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
              yield* handoffs.respond(
                { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
                sessionId,
              );
              const pending = yield* request({ apps: ["com.example.Editor"] }).pipe(
                Effect.forkChild,
              );
              yield* Deferred.await(entered);
              yield* orchestrator.dispatch({
                type: "thread.stop",
                commandId: CommandId.make("race-stop"),
                threadId,
              });
              const drain = yield* worker.drain().pipe(Effect.forkChild);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(pending);
              yield* Fiber.join(drain);
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("race-continue"),
                threadId,
                messageId: MessageId.make("message:race-continue"),
                text: "Continue",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
            }),
          );
        }),
      Layer.mock(Handoffs.Handoffs)({
        stopComputerUseSessions: (id, cutoff) =>
          Deferred.await(ready).pipe(
            Effect.flatMap((handoffs) => handoffs.stopComputerUseSessions(id, cutoff)),
          ),
      }),
    );
  }),
);

it.effect("a session approval older than the environment watermark cannot renew", () =>
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
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO computer_use_revocation_watermarks (scope, sequence) VALUES ('', (SELECT MAX(sequence) FROM orchestration_events)) ON CONFLICT(scope) DO UPDATE SET sequence = excluded.sequence`;
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect(
  "an always approval older than Stop does not automatically grant after the watermark",
  () =>
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
          yield* handoffs.stopComputerUseSessions(threadId);
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      ),
    ),
);

it.effect("an active standing grant cannot survive an environment watermark", () =>
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
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO computer_use_revocation_watermarks (scope, sequence) VALUES ('', (SELECT MAX(sequence) FROM orchestration_events)) ON CONFLICT(scope) DO UPDATE SET sequence = excluded.sequence`;
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);
