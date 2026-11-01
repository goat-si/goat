import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  HandoffError,
  MessageId,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { makeTestBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import { active, call, harness } from "../cua/ComputerUseLeaseProxy.testkit.ts";
import {
  makeComputerUseRpcHandlers,
  stopComputerUse,
  stopComputerUseFromHelper,
} from "../cua/ComputerUseRpcHandlers.ts";
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
          { threadId, handoffId: held.handoffId, action: "completed", computerUseScope: "session" },
          owner.sessionId,
        );
        yield* service.respond(
          { threadId: otherThread, handoffId: elsewhere.handoffId, action: "completed" },
          owner.sessionId,
        );
        yield* PubSub.take(wake);
        const live = yield* leases.control(threadId, yield* leases.active(threadId));
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* ServerSettings.ServerSettingsService;
        const allowedBefore = [...(yield* settings.getSettings).cuaAllowedApps];
        const sessionsBefore =
          yield* sql`SELECT * FROM computer_use_session_approvals ORDER BY thread_id, app_key`;
        const markerBefore = yield* sql`SELECT id FROM computer_use_person_approval ORDER BY id`;
        assert.isNotEmpty(allowedBefore);
        assert.isNotEmpty(sessionsBefore);
        assert.lengthOf(markerBefore, 1);
        const handoffBefore = yield* service.read({ threadId, handoffId: held.handoffId });
        const approvalBefore = yield* leases.active(threadId);
        const controlBefore = yield* leases.controlState(threadId, live.controlId);
        const claims = yield* makeTestBrowserOriginGrants({
          environmentId,
          supported: () => true,
          publish: () => Effect.void,
          bind: (input) =>
            Effect.succeed({
              targetId: "target-1",
              tabId: "tab-1",
              title: "Site",
              url: input.origin,
              driverGeneration: 1,
            }),
        });
        const attached = yield* claims.claim({
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        });
        assert.equal(attached.agentResult.status, "attached");
        const proxy = yield* harness({
          autoAppListing: true,
          autoListedApps: [{ pid: 42, bundle_id: app, name: "Browser" }],
        });
        yield* proxy.push({
          ...active(undefined, [app]),
          browserClaims: yield* claims.claimsFor(threadId),
        });
        yield* proxy.applied;
        yield* proxy.send(
          JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
        );
        yield* proxy.nextToDriver;
        yield* proxy.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            result: {
              tools: [
                { name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } },
              ],
            },
          }),
        );
        yield* proxy.nextToProvider;
        yield* proxy.send(call(100, "browser_click", { tab_id: "tab-1" }));
        assert.equal((yield* proxy.nextToDriver).id, 100);
        yield* proxy.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 100,
            result: { structuredContent: { tab_id: "tab-1", url: "https://example.test/" } },
          }),
        );
        assert.equal((yield* proxy.nextToProvider).id, 100);
        yield* claims.revoke(threadId, "https://example.test");
        assert.deepEqual((yield* settings.getSettings).cuaAllowedApps, allowedBefore);
        assert.deepEqual(
          yield* sql`SELECT * FROM computer_use_session_approvals ORDER BY thread_id, app_key`,
          sessionsBefore,
        );
        assert.deepEqual(
          yield* sql`SELECT id FROM computer_use_person_approval ORDER BY id`,
          markerBefore,
        );
        assert.deepEqual(
          yield* service.read({ threadId, handoffId: held.handoffId }),
          handoffBefore,
        );
        assert.deepEqual(yield* leases.active(threadId), approvalBefore);
        assert.deepEqual(yield* leases.controlState(threadId, live.controlId), controlBefore);
        // Its agent reads the window, so the thread has a card to stop (#1555).
        yield* leases.callReservation(threadId, {
          action: "reserve",
          controlId: live.controlId,
          connectionId: "driver:a",
          callId: "read",
          interruptions: 0,
          idleEpoch: 0,
          name: "list_apps",
          args: {},
        });
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
        // A turn whose attachment was already under way finishes after the Stop and mints a new
        // control. It can act on no app, so the thread's one card stays the stopped one (WS9).
        const late = yield* leases.control(threadId, Option.none());
        const lateState = yield* leases.controlState(threadId, late.controlId);
        assert.deepEqual(lateState._tag === "active" ? lateState.apps : undefined, []);
        const afterLate = (yield* leases.sessions).filter(
          ({ control }) => control.threadId === threadId,
        );
        assert.deepEqual(
          afterLate.map(({ control, state }) => [control.controlId === late.controlId, state]),
          [[false, { _tag: "ended", reason: "stopped" }]],
        );
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
            Layer.provideMerge(
              ServerSettings.layerTest({ enableCua: true, cuaAllowedApps: ["com.example.Other"] }),
            ),
            Layer.provide(dependencies),
          ),
        ),
      );
    }),
  ),
);

it.effect.each(["button", "person_esc"] as const)(
  "%s frees the apps its grant held for other threads at once",
  (source) =>
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
          const live = yield* leases.control(threadId, yield* leases.active(threadId));
          const otherControl = yield* leases.control(
            otherThread,
            yield* leases.active(otherThread),
          );
          // Its agent reads the window, so the thread has a card to stop (#1555).
          yield* leases.callReservation(threadId, {
            action: "reserve",
            controlId: live.controlId,
            connectionId: "driver:a",
            callId: "read",
            interruptions: 0,
            idleEpoch: 0,
            name: "list_apps",
            args: {},
          });
          assert.equal(
            Option.getOrUndefined(yield* leases.holder(otherThread, [app]))?.threadId,
            threadId,
          );

          // Stopping takes only the authority to stop agents, as Stop all does.
          const handlers = yield* makeComputerUseRpcHandlers(operator.sessionId);
          if (source === "button") {
            const result = yield* handlers[WS_METHODS.computerUseStop]({ threadId });
            assert.isTrue(result.stopped);
          } else {
            const entered = yield* Deferred.make<void>();
            const gate = yield* Deferred.make<void>();
            const delayed = {
              ...service,
              cancelComputerUseByPerson: (
                input: Parameters<typeof service.cancelComputerUseByPerson>[0],
              ) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(service.cancelComputerUseByPerson(input)),
                ),
            };
            const stopping = yield* stopComputerUseFromHelper(
              Option.some(leases),
              delayed,
              threadId,
              live.controlId,
            ).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Effect.sync(() => stopping.interruptUnsafe());
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.await(stopping);
          }

          assert.isTrue(Option.isNone(yield* leases.holder(otherThread, [app])));
          // The stopped card stays listed as stopped until a person closes it.
          const listed = (yield* leases.sessions).find(
            ({ control }) => control.threadId === threadId,
          );
          assert.deepEqual(listed?.state, {
            _tag: "ended",
            reason: source === "button" ? "stopped" : "stopped_all",
          });
          // A turn whose attachment was already under way finishes after the Stop and mints a new
          // control. It can act on no app, so the thread's one card stays the stopped one (WS9).
          const late = yield* leases.control(threadId, Option.none());
          const lateState = yield* leases.controlState(threadId, late.controlId);
          assert.deepEqual(lateState._tag === "active" ? lateState.apps : undefined, []);
          if (source === "person_esc") {
            const stale = yield* stopComputerUseFromHelper(
              Option.some(leases),
              service,
              otherThread,
              otherControl.controlId,
            );
            assert.isFalse(stale.stopped);
            assert.equal((yield* leases.controlState(threadId, late.controlId))._tag, "active");
          }

          const afterLate = (yield* leases.sessions).filter(
            ({ control }) => control.threadId === threadId,
          );
          assert.deepEqual(
            afterLate.map(({ control, state }) => [control.controlId === late.controlId, state]),
            [[false, { _tag: "ended", reason: source === "button" ? "stopped" : "stopped_all" }]],
          );
          assert.equal(
            (yield* service.read({ threadId, handoffId: held.handoffId })).state,
            "cancelled",
          );
          if (source === "person_esc") {
            assert.deepEqual(yield* leases.controlState(otherThread, otherControl.controlId), {
              _tag: "ended",
              reason: "stopped_all",
            });
            assert.equal(
              (yield* service.read({ threadId: otherThread, handoffId: elsewhere.handoffId }))
                .state,
              "cancelled",
            );
          } else {
            assert.equal((yield* leases.state(otherThread, elsewhere.handoffId))._tag, "active");
            const next = yield* ask(otherThread, [app]);
            yield* worker.drain();
            const approved = yield* service.respond(
              { threadId: otherThread, handoffId: next.handoffId, action: "completed" },
              owner.sessionId,
            );
            assert.equal(approved.state, "completed");
          }
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

// WS9 (Windows): the agent kept reading after Stop. A control the stopped thread gets afterwards
// must not use its approval, even when ending that approval fails; other threads stay blocked
// until it is really ended, so a restart cannot leave two threads holding one app.
it.effect("a thread's Stop keeps it off its approval even when that approval cannot be ended", () =>
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
      yield* worker.drain();
      const { owner, operator, environmentId, dependencies } =
        yield* computerUseGrantClients(orchestrator);
      yield* Effect.gen(function* () {
        const service = yield* Handoffs.Handoffs;
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const app = "computer-use-windows-fixture.exe";
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const held = yield* service.create({
          kind: "approval",
          title: "Allow computer use on test-host?",
          reason: "Read the fixture window",
          requestedBy: {
            threadId,
            providerInstanceId: instanceId,
            path: COMPUTER_USE_GRANT_HANDOFF_PATH,
          },
          target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "test-host until 00:30" },
          args: { purpose: "check", minutes: 30, apps: [app] },
          expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
          apps: [app],
        });
        yield* worker.drain();
        yield* service.respond(
          { threadId, handoffId: held.handoffId, action: "completed" },
          owner.sessionId,
        );
        yield* leases.control(threadId, yield* leases.active(threadId));
        // Ending the approval fails, as an unreachable store would.
        const failing = Handoffs.Handoffs.of({
          ...service,
          respond: () => Effect.fail(new HandoffError({ reason: "unavailable" })),
        });
        const result = yield* stopComputerUse(
          Option.some(leases),
          failing,
          operator.sessionId,
          threadId,
        );
        assert.deepEqual(result, { stopped: true, failed: 1 });
        assert.equal(
          (yield* service.read({ threadId, handoffId: held.handoffId })).state,
          "completed",
        );
        // Until its approval really ends, other threads still find the app held.
        assert.equal(
          Option.getOrUndefined(yield* leases.holder(otherThread, [app]))?.threadId,
          threadId,
        );
        const late = yield* leases.control(threadId, Option.none());
        const lateState = yield* leases.controlState(threadId, late.controlId);
        assert.deepEqual(lateState._tag === "active" ? lateState.apps : undefined, []);
        // The kill switch still finds it to end it.
        assert.deepEqual(
          (yield* leases.grants).map((grant) => grant.handoffId),
          [held.handoffId],
        );
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
