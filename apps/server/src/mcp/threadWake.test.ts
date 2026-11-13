import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { finishedWake, newLaunchWatch } from "./launchWatch.ts";
import { wakeThread } from "./threadWake.ts";

const session = ThreadId.make("goat-bot-session:wake");

/** Thread management that accepts every dispatch and counts the reads after it. */
const counting = () => {
  const counter = { reads: 0 };
  const threads = {
    dispatch: () => Effect.succeed({}),
    getThreadRecords: () =>
      Effect.sync(() => {
        counter.reads += 1;
        return { runs: [], messages: [] };
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  return { counter, threads };
};

it.effect("contract: only a stamped launch wake reads its thread after the wake is sent", () =>
  Effect.gen(function* () {
    const stamped = finishedWake({
      watch: newLaunchWatch({
        launcherThreadId: session,
        launcherRunId: RunId.make("run:launching"),
        host: null,
        threadId: ThreadId.make("thread:child"),
        projectId: null,
        title: "child",
        incarnation: "test",
        notifyWebhook: false,
        now: 0,
      }),
      runId: RunId.make("run:child"),
      status: "completed",
      title: "child",
      branch: null,
      worktreePath: null,
      excerpt: "Done.",
    });
    const wake = counting();
    yield* wakeThread(wake.threads, session, stamped);
    assert.strictEqual(wake.counter.reads, 1);
    const handoff = counting();
    yield* wakeThread(handoff.threads, session, {
      commandId: CommandId.make("command:handoff"),
      messageId: MessageId.make("message:handoff:answered"),
      text: "A person answered.",
      notification: {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Answered",
      },
    });
    assert.strictEqual(handoff.counter.reads, 0);
  }),
);
it.effect(
  "invariant: a failing or dying queue read after the wake was sent never fails the wake",
  () =>
    Effect.gen(function* () {
      const stamped = finishedWake({
        watch: newLaunchWatch({
          launcherThreadId: session,
          launcherRunId: RunId.make("run:launching"),
          host: null,
          threadId: ThreadId.make("thread:child"),
          projectId: null,
          title: "child",
          incarnation: "test",
          notifyWebhook: false,
          now: 0,
        }),
        runId: RunId.make("run:child"),
        status: "completed",
        title: "child",
        branch: null,
        worktreePath: null,
        excerpt: "Done.",
      });
      const sent = { run: "sent" } as never;
      for (const read of [Effect.fail("unreadable"), Effect.die("broken")]) {
        const threads = {
          dispatch: () => Effect.succeed(sent),
          getThreadRecords: () => read,
        } as unknown as ThreadManagementService.ThreadManagementService["Service"];
        assert.strictEqual(yield* wakeThread(threads, session, stamped), sent);
      }
    }),
);
