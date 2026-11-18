import {
  EventId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import {
  NOW,
  makeHarness,
  makeLink,
  makeSnapshot,
  makeThread,
  startAndSweep,
} from "./testkit/pullRequestSync.fixture.ts";

// Copied from PullRequestSyncReactor.test.ts, which is at its line budget.
function commandRan(
  threadId: ThreadId,
  input: string,
  output?: string,
  name = "command",
): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}:1`);
  const at = DateTime.makeUnsafe(NOW);
  return {
    type: "turn-item.updated",
    id: EventId.make(`event:${threadId}:${name}`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${threadId}:${name}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "command_execution",
      input,
      ...(output === undefined ? {} : { output }),
    },
  };
}

describe("PullRequestSyncReactor pushes", () => {
  it.effect("reopens a watch's checks when its thread's agent pushes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const watch = {
          startedAt: NOW,
          headSha: "aaaaaaaaaa",
          failedChecks: [],
          passed: true,
          passedChecks: ["test"],
          remarksThrough: NOW,
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("agent", {
              pullRequests: [
                makeLink(7, { state: "open" }, { watch: { ...watch, checksPending: false } }),
              ],
            }),
            makeThread("unread", {
              pullRequests: [makeLink(8, { state: "open" }, { watch })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          const agent = ThreadId.make("agent");
          yield* Queue.offerAll(fixture.domainEvents, [
            commandRan(agent, "git status && echo 'then git push'", undefined, "status"),
            // A watch that has not read its checks yet has no answer to forget.
            commandRan(ThreadId.make("unread"), "git push", undefined, "unread-push"),
            commandRan(agent, "cd app && git -C . push --force-with-lease", undefined, "push"),
            commandRan(agent, '/bin/zsh -lc "gh stack submit --auto"', undefined, "stack"),
          ]);
          for (const item of ["push", "stack"]) {
            const command = yield* Queue.take(fixture.reopenCommands);
            assert.deepStrictEqual(
              [command.threadId, command.commandId],
              [agent, `server:pr-push-checks:agent:item:agent:${item}`],
            );
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
