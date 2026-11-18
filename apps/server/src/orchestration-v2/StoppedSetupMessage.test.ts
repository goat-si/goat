import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError, MessageId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput, projectId } from "./testkit/threadLaunchInput.ts";

it.effect.each(["failed", "interrupted"] as const)(
  "holds every message that arrives after the setup %s without a worktree",
  (ending) => {
    let fetchEntered: Deferred.Deferred<void> | null = null;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        ending === "interrupted"
          ? Deferred.succeed(fetchEntered!, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
    });
    return Effect.gen(function* () {
      fetchEntered = yield* Deferred.make<void>();
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:late-queued-follow-up-${ending}`,
          thread: `thread:launch:late-queued-follow-up-${ending}`,
          message: "First message",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      if (ending === "interrupted") {
        yield* Deferred.await(fetchEntered);
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:launch:late-queued-follow-up:interrupt"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.updated" && stored.event.payload.status === ending,
        ),
        Stream.runHead,
      );

      const queued = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:send`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:send`),
        text: "Sent during setup",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.delivery, "queued");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      const held = projection.runs.at(-1)!;
      assert.equal(held.status, "queued");
      assert.equal(held.queueHeld, true);

      // A message sent fresh after the setup ended waits behind it too, rather
      // than starting in the project checkout with no worktree.
      const sentAfter = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:start`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:start`),
        text: "Sent after setup",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(sentAfter.delivery, "queued");
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:wake`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:wake`),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      const wake = (yield* threads.getThreadProjection(launched.threadId)).runs.at(-1)!;
      assert.equal(wake.status, "queued");
      assert.isTrue(wake.queueHeld);

      const sentAgain = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:again`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:again`),
        text: "Sent after that",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(sentAgain.delivery, "queued");
      const after = yield* threads.getThreadProjection(launched.threadId);
      assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
      assert.deepStrictEqual(
        after.runs.slice(1).map((run) => [run.status, run.queueHeld === true]),
        [
          ["queued", true],
          ["queued", true],
          ["queued", true],
          ["queued", true],
        ],
      );
      assert.equal(after.thread.worktreePath, null);
    }).pipe(Effect.provide(harness.layer));
  },
);
