import { it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  type OrchestrationV2DomainEvent,
  PREVIEW_HANDOFF_PATH,
  RunId,
  TurnItemId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewHandoffs from "./PreviewHandoffs.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { type HandoffChanged, makeSurface } from "./ServerBrowserScreen.ts";
import { SessionControl } from "./SessionControl.ts";

const environmentId = EnvironmentId.make("test-environment");
const reason = "Sign in with the code from your phone.";
const controlId = "control:1";
const desktopSession = `${PreviewHandoffs.DESKTOP_SESSION_PREFIX}${controlId}`;

/** PreviewHandoffs over a real thread and handoff store, one agent tab and one desktop control. */
const world = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  // Holds a person's ends on the tab until the test delivers them, to order them against a call.
  options: {
    readonly withholdEnds?: boolean;
    /** A desktop hold that tells nobody, so only the request's own deadline can end it. */
    readonly quietHold?: boolean;
    /** A live event stream that fails at once, so only the stored records can say what ended. */
    readonly brokenStream?: boolean;
    /** Record writes from the screen that fail before one goes through. */
    readonly failedWrites?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const handoffs = yield* (yield* durableHandoffs(orchestrator, {
      environmentId,
      sessions: Effect.succeed([]),
    })).start;
    const control = new SessionControl("agent-session");
    const tab = {
      threadId,
      tabId: "tab-1",
      control,
      page: { url: () => "https://login.example/" },
      desktop: null,
      viewers: new Set<never>(),
    };
    const surface = makeSurface(
      (thread, tabId) => (thread === threadId && tabId === tab.tabId ? tab : undefined),
      () => {},
    );
    const withheld: Array<HandoffChanged> = [];
    let deliverEnd: (ended: HandoffChanged) => void = () => {};
    if (options.withholdEnds) surface.service.onHandoffChange((ended) => void withheld.push(ended));
    // The screen's end is recorded once its transition command commits.
    const settled = yield* Queue.unbounded<string>();
    let failing = options.failedWrites ?? 0;
    // Like the orchestrator's receipts: an id that was refused stays refused.
    const refused = new Set<string>();
    const failed = yield* Deferred.make<void>();
    const dispatch = (
      command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
    ) =>
      command.type === "handoff.transition" &&
      ((failing > 0 && command.state !== "opened") || refused.has(command.commandId))
        ? Effect.suspend(() => {
            if (failing > 0) failing--;
            refused.add(command.commandId);
            return Deferred.succeed(failed, undefined).pipe(
              Effect.andThen(Effect.die("the record write failed")),
            );
          })
        : orchestrator
            .dispatch(command)
            .pipe(
              Effect.tap(() =>
                command.type === "handoff.transition"
                  ? Queue.offer(settled, command.state)
                  : Effect.void,
              ),
            );
    const desktop: Array<string> = [];
    const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 5 });
    const signals = yield* PubSub.unbounded<void>();
    let controlState: ComputerUseLeases.ComputerUseControlState = {
      _tag: "paused",
      reason: "human_input",
    };
    const requests = yield* Layer.build(
      PreviewHandoffs.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Handoffs.Handoffs, handoffs),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch,
              getThreadRecords: orchestrator.getThreadRecords,
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Layer.succeed(
              Orchestrator.OrchestratorV2,
              options.brokenStream
                ? { ...orchestrator, streamDomainEvents: Stream.die("the event stream broke") }
                : orchestrator,
            ),
            Layer.mock(ServerBrowser.ServerBrowser)({
              ...surface.service,
              ...(options.withholdEnds
                ? {
                    onHandoffChange: (listener: (ended: HandoffChanged) => void) => {
                      deliverEnd = listener;
                      return () => {};
                    },
                  }
                : {}),
              sessions: Effect.sync(() => [
                {
                  threadId,
                  tabId: tab.tabId,
                  url: tab.page.url(),
                  title: "Sign in",
                  agentId: control.agentId,
                  humanControls: control.controller !== null,
                  private: false,
                  agentStopped: control.isAgentStopped,
                  handoffReason: control.handoffReason,
                },
              ]),
            }),
            Layer.mock(ComputerUseLeases.ComputerUseLeases)({
              sessions: Effect.sync(() => [
                {
                  control: {
                    controlId,
                    threadId,
                    expiresAt,
                    acted: true,
                  },
                  state: controlState,
                },
              ]),
              hold: (held, on) =>
                Effect.sync(() => void desktop.push(`${held}:${on}`)).pipe(
                  Effect.andThen(
                    options.quietHold ? Effect.void : PubSub.publish(signals, undefined),
                  ),
                ),
              subscribe: PubSub.subscribe(signals),
              proxy: undefined,
            }),
          ),
        ),
      ),
    ).pipe(Effect.map((context) => Context.get(context, PreviewHandoffs.PreviewHandoffs)));
    // Ends the control without telling anyone, as an expiry does.
    const endControl = (reason: "stopped" | "expired" = "stopped") => {
      controlState = { _tag: "ended", reason };
    };
    const deliverWithheld = () => {
      for (const ended of withheld.splice(0)) deliverEnd(ended);
    };
    const deliver = (ended: HandoffChanged) => deliverEnd(ended);
    /** Completes once the tab is no longer held for a person. */
    const freed = yield* Deferred.make<void>();
    control.onChange(() => {
      if (control.handoffReason === null) Deferred.doneUnsafe(freed, Effect.void);
    });
    /** Completes once the tab's viewers are told a hand back was not recorded. */
    const unsaved = yield* Deferred.make<void>();
    control.onChange(() => {
      if (control.handBackFailed) Deferred.doneUnsafe(unsaved, Effect.void);
    });
    return {
      handoffs,
      requests,
      control,
      settled,
      failed,
      desktop,
      endControl,
      deliverWithheld,
      deliver,
      freed,
      unsaved,
    };
  });

it.effect(
  "holds an agent's tab for a person until they hand it back, which completes the request (#1218)",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, requests, control, settled, freed } = yield* world(orchestrator);
        const asked = { threadId, providerInstanceId: instanceId, reason, tabId: "tab-1" };
        const result = yield* requests.request(asked);
        expect(result.handoff).toMatchObject({
          state: "pending",
          targetPath: PREVIEW_HANDOFF_PATH,
        });
        expect(control.agentCanActNow("agent-session")).toBe(false);
        // Asking again while it is open returns the same request.
        expect((yield* requests.request(asked)).handoff.handoffId).toBe(result.handoff.handoffId);

        yield* Effect.promise(async () => {
          await control.take("viewer");
          await control.release("viewer");
        });
        // Taking it opens the request; handing it back completes it.
        expect([yield* Queue.take(settled), yield* Queue.take(settled)]).toEqual([
          "opened",
          "completed",
        ]);
        const record = yield* handoffs.read({ threadId, handoffId: result.handoff.handoffId });
        expect([record.state, record.actor]).toEqual([
          "completed",
          { type: "client", label: "Agent screen" },
        ]);
        // Freed only once the record took the hand back.
        yield* Deferred.await(freed);
        expect(control.agentCanActNow("agent-session")).toBe(true);
      }),
    ),
);

it.effect(
  "frees the tab when the request ends in the thread, without settling it again from the screen",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, requests, control, settled } = yield* world(orchestrator);
        const result = yield* requests.request({
          threadId,
          providerInstanceId: instanceId,
          reason,
          tabId: "tab-1",
        });
        const handoffId = TurnItemId.make(result.handoff.handoffId);
        yield* orchestrator.dispatch({
          type: "handoff.transition",
          commandId: CommandId.make(`handoff:${handoffId}:declined`),
          threadId,
          handoffId,
          state: "declined",
          actor: { type: "client", label: "Phone" },
        });
        yield* requests.recordEnded(yield* handoffs.read({ threadId, handoffId }));
        expect([control.handoffReason, control.agentCanActNow("agent-session")]).toEqual([
          null,
          true,
        ]);
        expect(yield* Queue.size(settled)).toBe(0);
      }),
    ),
);

it.effect("holds only the asking agent's desktop control, until the person hands it back", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, settled, desktop } = yield* world(orchestrator);
      const result = yield* requests.request({ threadId, providerInstanceId: instanceId, reason });
      expect(desktop).toEqual([`${controlId}:true`]);
      expect(yield* requests.desktopReasons).toEqual(new Map([[controlId, reason]]));
      // Take over opens the request and keeps it held while the person works.
      yield* requests.taken(desktopSession);
      expect(yield* Queue.take(settled)).toBe("opened");
      expect(yield* requests.desktopReasons).toEqual(new Map([[controlId, reason]]));

      yield* requests.handBack(desktopSession);
      expect(yield* Queue.take(settled)).toBe("completed");
      expect(desktop).toEqual([`${controlId}:true`, `${controlId}:false`]);
      expect(yield* requests.desktopReasons).toEqual(new Map());
      const record = yield* handoffs.read({
        threadId,
        handoffId: TurnItemId.make(result.handoff.handoffId),
      });
      expect(record.state).toBe("completed");
    }),
  ),
);

it.effect("cancels a desktop request once its control stops, by whatever path stopped it", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, settled, endControl } = yield* world(orchestrator);
      const result = yield* requests.request({ threadId, providerInstanceId: instanceId, reason });
      endControl();
      yield* requests.reconcileDesktop;
      expect(yield* Queue.take(settled)).toBe("cancelled");
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      // A person's Stop is recorded as the agent's own end, so the stopped agent is not woken.
      const record = yield* handoffs.read({ threadId, handoffId });
      expect([record.state, record.actor]).toEqual(["cancelled", { type: "agent", threadId }]);
      expect(yield* requests.desktopReasons).toEqual(new Map());
    }),
  ),
);

it.effect("cancels requests a restart left with nothing held", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const before = yield* world(orchestrator);
      const result = yield* before.requests.request({
        threadId,
        providerInstanceId: instanceId,
        reason,
        tabId: "tab-1",
      });
      // A fresh service on the same database: the tabs and their holds are gone.
      const after = yield* world(orchestrator);
      expect(yield* Queue.take(after.settled)).toBe("cancelled");
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      const record = yield* after.handoffs.read({ threadId, handoffId });
      expect([record.state, record.actor]).toEqual(["cancelled", { type: "server" }]);
    }),
  ),
);

it.effect("frees the tab when a person hands it back while the agent is asking again", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, control, settled, deliverWithheld, freed } = yield* world(
        orchestrator,
        { withholdEnds: true },
      );
      const asked = { threadId, providerInstanceId: instanceId, reason, tabId: "tab-1" };
      const result = yield* requests.request(asked);
      yield* Effect.promise(async () => {
        await control.take("viewer");
        await control.release("viewer");
      });
      // The agent asks again before GOAT has handled that hand back.
      expect((yield* requests.request(asked)).handoff.handoffId).toBe(result.handoff.handoffId);
      deliverWithheld();
      expect(yield* Queue.take(settled)).toBe("opened");
      expect(yield* Queue.take(settled)).toBe("completed");
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      expect((yield* handoffs.read({ threadId, handoffId })).state).toBe("completed");
      yield* Deferred.await(freed);
      expect(control.agentCanActNow("agent-session")).toBe(true);
    }),
  ),
);

it.effect("cancels a desktop request when its control expires, which sends no signal", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { requests, settled, endControl } = yield* world(orchestrator, { quietHold: true });
      yield* requests.request({ threadId, providerInstanceId: instanceId, reason });
      endControl("expired");
      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.take(settled)).toBe("cancelled");
      expect(yield* requests.desktopReasons).toEqual(new Map());
    }),
  ),
);

it.effect("ignores a late hand back of an earlier request when a newer one holds the tab", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, control, settled, deliverWithheld, deliver } = yield* world(
        orchestrator,
        { withholdEnds: true },
      );
      const ask = (step: string) =>
        requests.request({
          threadId,
          providerInstanceId: instanceId,
          reason: step,
          tabId: "tab-1",
        });
      const first = TurnItemId.make((yield* ask("Step A")).handoff.handoffId);
      yield* Effect.promise(async () => {
        await control.take("viewer");
        await control.release("viewer");
      });
      // Before GOAT handles that hand back, the thread declines A and the agent asks for B.
      yield* orchestrator.dispatch({
        type: "handoff.transition",
        commandId: CommandId.make(`handoff:${first}:declined`),
        threadId,
        handoffId: first,
        state: "declined",
        actor: { type: "client", label: "Phone" },
      });
      yield* requests.recordEnded(yield* handoffs.read({ threadId, handoffId: first }));
      const second = TurnItemId.make((yield* ask("Step B")).handoff.handoffId);
      expect(control.handoffReason).toBe("Step B");
      deliverWithheld();
      // Ends are handled in order: B's own Stop after A's late hand back is what settles B.
      deliver({ threadId, tabId: "tab-1", change: "ended", requestId: second });
      expect(yield* Queue.take(settled)).toBe("cancelled");
      expect((yield* handoffs.read({ threadId, handoffId: second })).state).toBe("cancelled");
    }),
  ),
);

it.effect(
  "frees the tab from the stored record when the event stream missed or lost the answer",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { requests, control, freed } = yield* world(orchestrator, { brokenStream: true });
        const result = yield* requests.request({
          threadId,
          providerInstanceId: instanceId,
          reason,
          tabId: "tab-1",
        });
        const handoffId = TurnItemId.make(result.handoff.handoffId);
        yield* orchestrator.dispatch({
          type: "handoff.transition",
          commandId: CommandId.make(`handoff:${handoffId}:declined`),
          threadId,
          handoffId,
          state: "declined",
          actor: { type: "client", label: "Phone" },
        });
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(freed);
        expect(control.agentCanActNow("agent-session")).toBe(true);
      }),
    ),
);

it.effect("ends a request without a wake when a person archives the thread", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, settled, freed } = yield* world(orchestrator, {
        brokenStream: true,
      });
      const result = yield* requests.request({
        threadId,
        providerInstanceId: instanceId,
        reason,
        tabId: "tab-1",
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-thread"),
        threadId,
      });
      yield* TestClock.adjust("15 seconds");
      expect(yield* Queue.take(settled)).toBe("cancelled");
      yield* Deferred.await(freed);
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      // Ended as the agent would, so the wake reactor stays quiet.
      expect((yield* handoffs.read({ threadId, handoffId })).actor).toEqual({
        type: "agent",
        threadId,
      });
    }),
  ),
);

it.effect("ends a request without a wake when a person stops the turn that asked", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const { handoffs, requests, settled, freed } = yield* world(orchestrator, {
        brokenStream: true,
      });
      const result = yield* requests.request({
        threadId,
        providerInstanceId: instanceId,
        reason,
        tabId: "tab-1",
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-run"),
        threadId,
        runId: run.id,
        holdQueue: true,
      });
      yield* worker.drain();
      yield* TestClock.adjust("15 seconds");
      expect(yield* Queue.take(settled)).toBe("cancelled");
      yield* Deferred.await(freed);
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      expect((yield* handoffs.read({ threadId, handoffId })).actor.type).toBe("agent");
    }),
  ),
);

it.effect("leaves a newer turn's request held when a Stop of an earlier turn arrives late", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { requests, control, settled } = yield* world(orchestrator, { brokenStream: true });
      yield* requests.request({ threadId, providerInstanceId: instanceId, reason, tabId: "tab-1" });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      const occurredAt = yield* DateTime.now;
      const stopOf = (runId: RunId): OrchestrationV2DomainEvent => ({
        type: "run.updated",
        id: EventId.make(`event:stop:${runId}`),
        threadId,
        occurredAt,
        payload: {
          ...run,
          id: runId,
          status: "interrupted",
          terminationCause: { kind: "person_stop" },
        },
      });
      yield* requests.handle(stopOf(RunId.make("run:earlier")));
      expect(control.handoffReason).toBe(reason);
      expect(yield* Queue.size(settled)).toBe(0);
      yield* requests.handle(stopOf(run.id));
      expect(yield* Queue.take(settled)).toBe("cancelled");
      expect(control.handoffReason).toBe(null);
    }),
  ),
);

it.effect("keeps a desktop request held when its hand back is not recorded, and says so", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, settled, desktop } = yield* world(orchestrator, {
        brokenStream: true,
        failedWrites: 1,
      });
      const result = yield* requests.request({ threadId, providerInstanceId: instanceId, reason });
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      const failure = yield* requests.handBack(desktopSession).pipe(Effect.flip);
      expect(failure.reason).toBe("unavailable");
      expect(desktop).toEqual([`${controlId}:true`]);
      expect(yield* requests.desktopReasons).toEqual(new Map([[controlId, reason]]));
      expect((yield* handoffs.read({ threadId, handoffId })).state).toBe("pending");
      // The person sees the error and hands it back again.
      yield* requests.handBack(desktopSession);
      expect(yield* Queue.take(settled)).toBe("completed");
      expect(desktop).toEqual([`${controlId}:true`, `${controlId}:false`]);
      expect((yield* handoffs.read({ threadId, handoffId })).state).toBe("completed");
    }),
  ),
);

it.effect(
  "keeps a tab held when a hand back on its stream is not recorded, until a check records it",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, requests, control, settled, failed, freed, unsaved } = yield* world(
          orchestrator,
          {
            brokenStream: true,
            failedWrites: 1,
          },
        );
        const result = yield* requests.request({
          threadId,
          providerInstanceId: instanceId,
          reason,
          tabId: "tab-1",
        });
        const handoffId = TurnItemId.make(result.handoff.handoffId);
        yield* Effect.promise(async () => {
          await control.take("viewer");
          await control.release("viewer");
        });
        yield* Deferred.await(failed);
        expect(control.handoffReason).toBe(reason);
        expect(control.agentCanActNow("agent-session")).toBe(false);
        expect(yield* Queue.take(settled)).toBe("opened");
        // The person who handed it back sees that it did not take.
        yield* Deferred.await(unsaved);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Queue.take(settled)).toBe("completed");
        yield* Deferred.await(freed);
        expect((yield* handoffs.read({ threadId, handoffId })).state).toBe("completed");
        expect(control.agentCanActNow("agent-session")).toBe(true);
      }),
    ),
);

it.effect(
  "ends a tab's request as the agent's own when a person stops it, so no wake follows",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, requests, control, settled, failed } = yield* world(orchestrator, {
          brokenStream: true,
          failedWrites: 1,
        });
        const result = yield* requests.request({
          threadId,
          providerInstanceId: instanceId,
          reason,
          tabId: "tab-1",
        });
        const handoffId = TurnItemId.make(result.handoff.handoffId);
        // A hand back that was not recorded, then Stop: the Stop is what ends it.
        yield* Effect.promise(async () => {
          await control.take("viewer");
          await control.release("viewer");
        });
        yield* Deferred.await(failed);
        control.stopAgents();
        expect(yield* Queue.take(settled)).toBe("opened");
        expect(yield* Queue.take(settled)).toBe("cancelled");
        yield* TestClock.adjust("15 seconds");
        const record = yield* handoffs.read({ threadId, handoffId });
        expect([record.state, record.actor]).toEqual(["cancelled", { type: "agent", threadId }]);
      }),
    ),
);

it.effect("retries a Stop whose record write failed, so the stopped agent is never woken", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, control, settled, failed } = yield* world(orchestrator, {
        brokenStream: true,
        failedWrites: 1,
      });
      const result = yield* requests.request({
        threadId,
        providerInstanceId: instanceId,
        reason,
        tabId: "tab-1",
      });
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      control.stopAgents();
      yield* Deferred.await(failed);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Queue.take(settled)).toBe("cancelled");
      // Past the request's own deadline it stays the agent's end, which wakes nobody.
      yield* TestClock.adjust("31 minutes");
      const record = yield* handoffs.read({ threadId, handoffId });
      expect([record.state, record.actor]).toEqual(["cancelled", { type: "agent", threadId }]);
    }),
  ),
);

it.effect("ends an unrecorded hand back as a Stop when a person stops the turn meanwhile", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const { handoffs, requests, control, settled, failed } = yield* world(orchestrator, {
        brokenStream: true,
        failedWrites: 1,
      });
      const result = yield* requests.request({
        threadId,
        providerInstanceId: instanceId,
        reason,
        tabId: "tab-1",
      });
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      yield* Effect.promise(async () => {
        await control.take("viewer");
        await control.release("viewer");
      });
      yield* Deferred.await(failed);
      // The turn is stopped while no event reaches the service; the next check sees both.
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-run"),
        threadId,
        runId: run.id,
        holdQueue: true,
      });
      yield* worker.drain();
      yield* TestClock.adjust("15 seconds");
      expect(yield* Queue.take(settled)).toBe("opened");
      expect(yield* Queue.take(settled)).toBe("cancelled");
      const record = yield* handoffs.read({ threadId, handoffId });
      expect([record.state, record.actor]).toEqual(["cancelled", { type: "agent", threadId }]);
    }),
  ),
);

it.effect("frees the desktop and says so when the request expired before the hand back", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { handoffs, requests, desktop } = yield* world(orchestrator, { brokenStream: true });
      const result = yield* requests.request({ threadId, providerInstanceId: instanceId, reason });
      const handoffId = TurnItemId.make(result.handoff.handoffId);
      yield* TestClock.adjust("31 minutes");
      const failure = yield* requests.handBack(desktopSession).pipe(Effect.flip);
      expect(failure.reason).toBe("expired");
      expect(desktop).toEqual([`${controlId}:true`, `${controlId}:false`]);
      expect((yield* handoffs.read({ threadId, handoffId })).state).toBe("expired");
    }),
  ),
);
