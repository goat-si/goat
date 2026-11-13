import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { foldIntoQueuedNotice } from "../orchestration-v2/TurnDigest.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import { ask, current, sessionHarness, settle } from "./ChannelBotSession.testkit.ts";
import { setupBot } from "./testkit/ChannelHarness.ts";
import { launchWatchesOf } from "./testkit/launchWakesFake.ts";

const usage = (usedTokens: number) => [
  { tokenUsage: { usedTokens, maxTokens: 200_000, updatedAt: "1970-01-01T00:00:00.000Z" } },
];

const notification: OrchestrationV2Notification = {
  source: { kind: "background_task" },
  outcome: "completed",
  summary: "A coding thread finished",
};

/**
 * Queues a launched thread's run-end wake on the session as the orchestrator does: folded into the
 * queued notice turn when TurnDigest says so, otherwise as a run of its own.
 */
const deliverWake = (
  harness: ReturnType<typeof sessionHarness>,
  notices: Map<string, OrchestrationV2ConversationMessage>,
  session: ThreadId,
  child: ThreadId,
) => {
  const messageId = MessageId.make(
    "message:launch-watch:" +
      [session, "", child].map(encodeURIComponent).join(":") +
      ":run:run:" +
      child +
      ":1",
  );
  const text = child + " finished.";
  const fold = foldIntoQueuedNotice(
    { runs: harness.world.runs.get(session) ?? [], messages: [...notices.values()] },
    {
      type: "message.dispatch",
      commandId: CommandId.make("wake:" + child),
      threadId: session,
      messageId,
      text,
      notification,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    },
    DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
  );
  if (fold !== undefined) return;
  notices.set(messageId, {
    id: messageId,
    text,
    createdBy: "agent",
    creationSource: "server",
    notification,
  } as unknown as OrchestrationV2ConversationMessage);
  harness.world.addRun(session, messageId);
};

it.effect(
  "regression: a session whose two coding threads finished together rotates once both results ran",
  () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* ask("look: one", "w1");
      const session = first.worker!.threadId;
      const children = [ThreadId.make("thread:child-a"), ThreadId.make("thread:child-b")];
      for (const child of children) {
        const admitted = yield* childWork.admit({
          callerThreadId: session,
          callerRunId: first.worker!.runId,
          surface: "thread_launch",
          prompt: "fix " + child,
          destinationKey: "codex",
        });
        if (admitted._tag !== "admitted") return yield* Effect.die("expected admission");
        harness.world.addRun(child, MessageId.make("msg:" + child));
        yield* Effect.scoped(childWork.claimLaunch(admitted.record, { threadId: child }));
        yield* childWork.markBound(admitted.record, { threadId: child });
        launchWatchesOf(harness.world).set(child, {
          detached: false,
          skippedRuns: [],
          reportedEnds: {},
        });
        harness.world.setStatus(child, 1, "completed", "Fixed.");
        yield* childWork.markTerminal(admitted.record, "completed");
      }
      // Both ends arrive while the session's turn still runs, so they wait behind it.
      const notices = new Map<string, OrchestrationV2ConversationMessage>();
      for (const child of children) deliverWake(harness, notices, session, child);
      harness.world.providerTurns.set(session, usage(195_000));
      for (const run of harness.world.runs.get(session) ?? [])
        harness.world.setStatus(session, run.ordinal, "completed", "Done.");
      const next = yield* ask("look: two", "w2");
      yield* settle;
      const rotated = yield* current(next.taskId);
      assert.isDefined(rotated.worker);
      assert.notStrictEqual(rotated.worker?.threadId, session);
    }).pipe(Effect.provide(harness.layer));
  },
);
