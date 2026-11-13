import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2ServerCommand, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { warnLaunchWakeKeyCrossing } from "./launchWakeKeyWarning.ts";

const wakeId =
  "message:launch-watch:" + encodeURIComponent("goat-bot-session:w") + "::child:run:run:child:1";

const command = {
  type: "message.dispatch",
  commandId: CommandId.make("command:wake"),
  threadId: ThreadId.make("goat-bot-session:w"),
  messageId: MessageId.make(wakeId),
  text: "child finished.",
  notification: {
    source: { kind: "background_task" },
    outcome: "completed",
    summary: "child completed",
    aboutRunId: "run:launching",
  },
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  createdBy: "agent",
  creationSource: "server",
} as unknown as OrchestrationV2ServerCommand;

const store = (read: Effect.Effect<unknown, string>) =>
  ({ getThreadRecords: () => read }) as unknown as Pick<ProjectionStoreV2Shape, "getThreadRecords">;

it.effect(
  "invariant: nothing in the launch-wake key warning can fail the dispatch that called it",
  () =>
    Effect.gen(function* () {
      // A stored wake message without text makes the key count itself throw.
      const malformed = Effect.succeed({
        runs: [{ id: "run:wake", ordinal: 1, status: "queued", userMessageId: wakeId }],
        messages: [
          {
            id: wakeId,
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "background_task" }, aboutRunId: "run:launching" },
          },
        ],
      });
      for (const read of [Effect.fail("unreadable"), Effect.die("broken"), malformed]) {
        const exit = yield* Effect.exit(warnLaunchWakeKeyCrossing(store(read), command));
        assert.isTrue(Exit.isSuccess(exit));
      }
    }),
);
it.effect(
  "invariant: an outside interruption waits for the warning's read, so the helper adds no interruption point after the commit",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let readDone = false;
      const held = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        readDone = true;
        return { runs: [], messages: [] };
      });
      const fiber = yield* Effect.forkChild(warnLaunchWakeKeyCrossing(store(held), command));
      yield* Deferred.await(started);
      // Delivered at once while the read is parked on its gate.
      fiber.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(fiber);
      assert.isTrue(readDone);
    }),
);
