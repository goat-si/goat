import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { stopAllComputerUse } from "../cua/ComputerUseRpcHandlers.ts";
import * as Handoffs from "./Handoffs.ts";
import { computerUseGrantClients, instanceId, threadId, withHarness } from "./Handoffs.testkit.ts";

it.effect(
  "computer use grants: settings:write approves, overlapping grants exclude each other, ending early, expiry and an operator's Stop all end the lease",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const otherThread = ThreadId.make("thread:handoff-tests-other");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-other-thread"),
          threadId: otherThread,
          projectId: ProjectId.make("project:handoff-tests"),
          title: "Scheduled check",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-other-run"),
          threadId: otherThread,
          messageId: MessageId.make("message:other"),
          text: "Look at the screen",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
        });
        yield* worker.drain();
        const { owner, operator, environmentId, dependencies } =
          yield* computerUseGrantClients(orchestrator);
        yield* Effect.gen(function* () {
          const service = yield* Handoffs.Handoffs;
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const wake = yield* leases.subscribe;
          const ask = (thread: ThreadId, apps?: ReadonlyArray<string>) =>
            Effect.gen(function* () {
              const run = (yield* orchestrator.getThreadProjection(thread)).runs.at(-1)!;
              return yield* service.create({
                kind: "approval",
                title: "Allow computer use on test-host?",
                reason: "Check the build status window",
                requestedBy: {
                  threadId: thread,
                  providerInstanceId: instanceId,
                  path: COMPUTER_USE_GRANT_HANDOFF_PATH,
                },
                target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
                runId: run.id,
                nodeId: run.rootNodeId!,
                human: { location: "test-host until 00:30" },
                args: { purpose: "check", minutes: 30, ...(apps === undefined ? {} : { apps }) },
                expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
                ...(apps === undefined ? {} : { apps }),
              });
            });
          const first = yield* ask(threadId);
          const second = yield* ask(otherThread);
          yield* worker.drain();
          const firstAddress = { threadId, handoffId: first.handoffId };
          const secondAddress = { threadId: otherThread, handoffId: second.handoffId };
          // Admission needs the same authority as turning computer use on.
          assert.equal(
            (yield* service
              .respond({ ...firstAddress, action: "completed" }, operator.sessionId)
              .pipe(Effect.result))._tag,
            "Failure",
          );
          yield* service.respond({ ...firstAddress, action: "completed" }, owner.sessionId);
          yield* PubSub.take(wake);
          const lease = yield* leases.active(threadId);
          assert.isTrue(Option.isSome(lease));
          assert.equal(
            Option.getOrUndefined(yield* leases.holder(otherThread, undefined))?.threadId,
            threadId,
          );
          // A whole-screen grant overlaps every other, so a second one waits for the holder.
          const refused = yield* service
            .respond({ ...secondAddress, action: "completed" }, owner.sessionId)
            .pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          // Ending early is a durable transition every client sees, and it wakes proxies.
          const ended = yield* service.respond(
            { ...firstAddress, action: "cancelled" },
            owner.sessionId,
          );
          assert.equal(ended.state, "cancelled");
          yield* PubSub.take(wake);
          assert.isTrue(Option.isNone(yield* leases.active(threadId)));
          assert.deepEqual(yield* leases.state(threadId, first.handoffId), {
            _tag: "ended",
            reason: "revoked",
          });
          yield* service.respond({ ...secondAddress, action: "completed" }, owner.sessionId);
          assert.equal((yield* leases.state(otherThread, second.handoffId))._tag, "active");
          yield* TestClock.adjust("30 minutes");
          assert.deepEqual(yield* leases.state(otherThread, second.handoffId), {
            _tag: "ended",
            reason: "expired",
          });
          assert.isTrue(Option.isNone(yield* leases.holder(undefined, undefined)));

          // Stop all is for whoever may stop agents: revoking a grant only narrows access, so an
          // operator without settings:write still ends it instead of leaving it for the next turn.
          const third = yield* ask(threadId);
          yield* worker.drain();
          const thirdAddress = { threadId, handoffId: third.handoffId };
          yield* service.respond({ ...thirdAddress, action: "completed" }, owner.sessionId);
          yield* PubSub.take(wake);
          assert.isTrue(Option.isSome(yield* leases.active(threadId)));
          const stopped = yield* stopAllComputerUse(
            Option.some(leases),
            service,
            operator.sessionId,
          );
          assert.deepEqual(stopped, { stopped: 1, failed: 0 });
          assert.equal((yield* service.read(thirdAddress)).state, "cancelled");
          assert.isTrue(Option.isNone(yield* leases.active(threadId)));
          // Approving still takes settings:write.
          const fourth = yield* ask(otherThread);
          yield* worker.drain();
          assert.equal(
            (yield* service
              .respond(
                { threadId: otherThread, handoffId: fourth.handoffId, action: "completed" },
                operator.sessionId,
              )
              .pipe(Effect.result))._tag,
            "Failure",
          );

          // Regression: grants for different apps hold at once; a shared app still conflicts.
          const kakao = yield* ask(threadId, ["com.kakao.KakaoTalk"]);
          const aside = yield* ask(otherThread, ["at.studio.AsideBrowser"]);
          yield* worker.drain();
          yield* service.respond(
            { threadId, handoffId: kakao.handoffId, action: "completed" },
            owner.sessionId,
          );
          yield* service.respond(
            { threadId: otherThread, handoffId: aside.handoffId, action: "completed" },
            owner.sessionId,
          );
          assert.equal((yield* leases.state(threadId, kakao.handoffId))._tag, "active");
          assert.equal((yield* leases.state(otherThread, aside.handoffId))._tag, "active");
          const shared = yield* ask(otherThread, ["com.kakao.kakaotalk"]);
          yield* worker.drain();
          const conflict = yield* service
            .respond(
              { threadId: otherThread, handoffId: shared.handoffId, action: "completed" },
              owner.sessionId,
            )
            .pipe(Effect.flip);
          assert.equal(
            conflict._tag === "HandoffError" ? conflict.reason : conflict._tag,
            "conflict",
          );
          assert.include(conflict.message, "com.kakao.KakaoTalk");
          assert.include(conflict.message, threadId);
        }).pipe(
          Effect.provide(
            Handoffs.layer.pipe(
              Layer.provideMerge(ComputerUseLeases.layer),
              Layer.provide(dependencies),
            ),
          ),
        );
      }),
    ),
);
