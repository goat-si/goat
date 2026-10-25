import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { makeComputerUseRpcHandlers } from "../cua/ComputerUseRpcHandlers.ts";
import * as Handoffs from "./Handoffs.ts";
import { computerUseGrantClients, instanceId, threadId, withHarness } from "./Handoffs.testkit.ts";

// Regression for #1519: a card's Stop ended the control but left the grant holding the app for
// the rest of its minutes, so another thread asking for it was refused as held.
it.effect("a thread's Stop frees the apps its grant held for other threads at once", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const otherThread = ThreadId.make("thread:handoff-tests-other");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-other-thread"),
        threadId: otherThread,
        projectId: ProjectId.make("project:handoff-tests"),
        title: "Other thread",
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
        text: "Look at the fixture",
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
        const app = "computer-use-windows-fixture.exe";
        const ask = (thread: ThreadId, apps: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const run = (yield* orchestrator.getThreadProjection(thread)).runs.at(-1)!;
            return yield* service.create({
              kind: "approval",
              title: "Allow computer use on test-host?",
              reason: "Read the fixture window",
              requestedBy: {
                threadId: thread,
                providerInstanceId: instanceId,
                path: COMPUTER_USE_GRANT_HANDOFF_PATH,
              },
              target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
              runId: run.id,
              nodeId: run.rootNodeId!,
              human: { location: "test-host until 00:30" },
              args: { purpose: "check", minutes: 30, apps },
              expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
              apps,
            });
          });
        const held = yield* ask(threadId, [app]);
        const elsewhere = yield* ask(otherThread, ["at.studio.AsideBrowser"]);
        yield* worker.drain();
        yield* service.respond(
          { threadId, handoffId: held.handoffId, action: "completed" },
          owner.sessionId,
        );
        yield* service.respond(
          { threadId: otherThread, handoffId: elsewhere.handoffId, action: "completed" },
          owner.sessionId,
        );
        yield* PubSub.take(wake);
        yield* leases.control(threadId, yield* leases.active(threadId));
        assert.equal(
          Option.getOrUndefined(yield* leases.holder(otherThread, [app]))?.threadId,
          threadId,
        );

        // Stopping takes only the authority to stop agents, as Stop all does.
        const handlers = yield* makeComputerUseRpcHandlers(operator.sessionId);
        const result = yield* handlers[WS_METHODS.computerUseStop]({ threadId });
        assert.deepEqual(result, { stopped: true });

        assert.isTrue(Option.isNone(yield* leases.holder(otherThread, [app])));
        // The stopped card stays listed as stopped until a person closes it.
        const listed = (yield* leases.sessions).find(
          ({ control }) => control.threadId === threadId,
        );
        assert.deepEqual(listed?.state, { _tag: "ended", reason: "stopped" });
        assert.equal(
          (yield* service.read({ threadId, handoffId: held.handoffId })).state,
          "cancelled",
        );
        // Only the stopped thread lets go: another thread's grant keeps its apps.
        assert.equal((yield* leases.state(otherThread, elsewhere.handoffId))._tag, "active");
        const next = yield* ask(otherThread, [app]);
        yield* worker.drain();
        const approved = yield* service.respond(
          { threadId: otherThread, handoffId: next.handoffId, action: "completed" },
          owner.sessionId,
        );
        assert.equal(approved.state, "completed");
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
