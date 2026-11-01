import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  EnvironmentAuthorizationError,
  PreviewTabId,
  type EnvironmentId,
  type ProviderInstanceId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ScreenHostCall,
  type ThreadId,
} from "@goat/contracts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { makeTabClaims, TabClaims } from "./TabClaims.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { handleScreenRunEvent } from "./ScreenRunTurnEnd.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits(),
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "session",
      providerInstanceId: "provider" as ProviderInstanceId,
    },
    reauthorize: () => Effect.void,
  },
};
const call = (kind: "tab" | "app", callId: number): ScreenHostCall => ({
  t: "call",
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  callId,
  targetRef: { id: kind, kind, environmentId: "env", runId: "run", turnId: "turn", generation: 0 },
  method: "click",
  args: {},
  deadlineMillis: 100,
});

it.effect.each([
  { first: "app", next: "tab", title: "cutting a mixed cell blocks its next browser effect" },
  { first: "tab", next: "app", title: "cutting a mixed cell blocks its next desktop effect" },
] as const)("$title", ({ first, next }) =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.gen(function* () {
          dispatched++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
          return { category: "confirmed" as const, evidence: ["after-cut"] };
        }),
    });
    const pending = yield* bridge.handle(call(first, 1), context).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* bridge.cutCell("run", "turn", "cell", "control changed");
    const late = yield* Fiber.join(pending);
    yield* Deferred.succeed(finish, undefined);
    const blocked = yield* bridge.handle(call(next, 2), context);
    const journal = yield* bridge.takeCellImages("run", "turn", "cell");
    expect(late?.outcome).toBe("error");
    expect(late && "error" in late ? late.error?.code : undefined).toBe("unknown_outcome");
    expect(blocked && "error" in blocked ? blocked.error?.code : undefined).toBe("stopped");
    expect(dispatched).toBe(1);
    expect(journal.journal[0]?.receipt).toMatchObject({
      journalState: "unknown",
      category: "unknown_outcome",
      dispatched: true,
    });
  }),
);

it.effect(
  "Turn completion closes a temporary tab before releasing its claim and records failure",
  () =>
    Effect.gen(function* () {
      let heldDuringClose = false;
      const identity = {
        environmentId: "env",
        threadId: "thread",
        runId: "run",
        turnId: "turn",
        browserInstanceId: "browser",
        connectionId: "connection",
        tabId: "temporary",
        controlGeneration: 1,
      };
      let claims: TabClaims["Service"];
      claims = yield* makeTabClaims(() =>
        Effect.gen(function* () {
          heldDuringClose =
            (yield* claims.assertCurrent(identity).pipe(Effect.option))._tag === "Some";
          return yield* Effect.die(new Error("close failed"));
        }),
      );
      yield* claims.recordOpened(identity);
      const authority = yield* claims.captureCleanup(identity);
      const outcomes = yield* claims.releaseTurn(identity, authority);
      expect(heldDuringClose).toBe(true);
      expect(outcomes).toEqual([{ tabId: "temporary", status: "failed" }]);
      expect((yield* claims.assertCurrent(identity).pipe(Effect.option))._tag).toBe("None");
    }),
);

it.effect("The call ceiling refuses the next effect with prior receipts", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          dispatched++;
          return { category: "confirmed" as const, evidence: ["done"] };
        }),
    });
    const limited = { ...context, limits: screenRunLimits({ callsPerCell: 1 }) };
    const first = yield* bridge.handle(call("app", 1), limited);
    const second = yield* bridge.handle(call("app", 2), limited);
    expect(first?.outcome).toBe("ok");
    expect(second && "error" in second ? second.error : undefined).toMatchObject({
      code: "call_limit",
      effectStarted: false,
      limit: { name: "callsPerCell", maximum: 1 },
      receipts: [{ callId: 1, category: "confirmed" }],
    });
    expect(dispatched).toBe(1);
  }),
);

it.effect("a full journal refuses the next effect so no input runs without a receipt", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          dispatched++;
          return { category: "confirmed" as const, evidence: ["done"] };
        }),
    });
    const limited = { ...context, limits: screenRunLimits({ journalEntries: 1 }) };
    const first = yield* bridge.handle(call("app", 1), limited);
    const second = yield* bridge.handle(call("app", 2), limited);
    expect(first?.outcome).toBe("ok");
    expect(second && "error" in second ? second.error : undefined).toMatchObject({
      code: "call_limit",
      effectStarted: false,
      limit: { name: "journalEntries", maximum: 1 },
    });
    expect(dispatched).toBe(1);
  }),
);

it.effect("Stop releases the tab claim while a later cell can claim fresh authority", () =>
  Effect.gen(function* () {
    const identity = {
      environmentId: "env",
      threadId: "thread",
      runId: "run",
      turnId: "turn",
      browserInstanceId: "browser",
      connectionId: "connection",
      tabId: "temporary",
      controlGeneration: 1,
    };
    let closed = 0;
    const claims = yield* makeTabClaims(() =>
      Effect.sync(() => {
        closed++;
      }),
    );
    yield* claims.recordOpened(identity);
    yield* claims.suspendClaims(identity, identity.tabId);
    expect((yield* claims.assertCurrent(identity).pipe(Effect.option))._tag).toBe("None");
    expect(
      (yield* claims.recordOpened({ ...identity, tabId: "later", controlGeneration: 2 }))
        .claimEpoch,
    ).toBeGreaterThan(0);
    const cutoff = yield* claims.captureCleanup(identity);
    expect((yield* claims.releaseTurn(identity, cutoff)).map((item) => item.status)).toEqual([
      "closed",
      "closed",
    ]);
    expect(closed).toBe(2);
  }),
);

it.effect("Credential revocation fences the next desktop effect in the same cell", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          dispatched++;
          return { category: "confirmed" as const, evidence: ["done"] };
        }),
    });
    const revoked = {
      ...context,
      invocation: {
        ...context.invocation,
        reauthorize: () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: "The session was revoked.",
              requiredScope: "memory:read",
            }),
          ),
      },
    };
    const first = yield* bridge.handle(call("tab", 1), revoked);
    const second = yield* bridge.handle(call("app", 2), revoked);
    expect(first && "error" in first ? first.error?.code : undefined).toBe("permission_denied");
    expect(second && "error" in second ? second.error?.code : undefined).toBe("stopped");
    expect(dispatched).toBe(0);
  }),
);

it.live(
  "Pause kills the current child and requires a fresh binding before the next observation",
  () => {
    let nextTarget = 0;
    let observations = 0;
    const request = {
      runId: "run",
      turnId: "turn",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
    };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const first = yield* service.runCell({
        ...request,
        source: "return (await screen.tab({tabId: 'tab'})).targetRef;",
      });
      expect(first.status).toBe("completed");
      yield* service.controlChanged({ kind: "pause", threadId: "thread" });
      const stale = yield* service
        .runCell({
          ...request,
          source: `return await screen.observe({targetRef: ${JSON.stringify(first.value)}});`,
        })
        .pipe(Effect.result);
      expect(stale._tag).toBe("Failure");
      if (stale._tag === "Failure") expect(stale.failure.code).toBe("stale_reference");
      expect(observations).toBe(0);
      const fresh = yield* service.runCell({
        ...request,
        source: "const tab = await screen.tab({tabId: 'tab'}); return await tab.observe();",
      });
      expect(fresh.value).toEqual({ tree: "fresh" });
      expect(observations).toBe(1);
      yield* service.finishTurn({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          dispatcher: {
            availability: () => Effect.succeed([{ kind: "tab", available: true }]),
            dispatch: (call) =>
              Effect.sync(() =>
                call.method === "select_tab"
                  ? {
                      value: {
                        targetRef: {
                          id: `target-${++nextTarget}`,
                          kind: "tab" as const,
                          environmentId: "env",
                          runId: "run",
                          turnId: "turn",
                          generation: 0,
                        },
                        tab: { tabId: "tab" },
                      },
                      category: "confirmed" as const,
                      evidence: ["bound"],
                    }
                  : (observations++,
                    {
                      value: { tree: "fresh" },
                      category: "confirmed" as const,
                      evidence: ["observed"],
                    }),
              ),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

it.live("Stop cleanup failure appears in the turn journal and next cell result", () => {
  let opened = false;
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("temporary"),
    title: "Page",
    url: "https://example.test/",
    owner: "agent" as const,
    ownedByCaller: true,
    controlGeneration: 1,
  };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed(opened ? [tab] : []),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      request.operation === "close"
        ? Effect.die(new Error("close failed"))
        : Effect.sync(() => {
            if (request.operation === "open") opened = true;
            return (
              request.operation === "status"
                ? {
                    tabId: tab.tabId,
                    url: tab.url,
                    control: { owner: "agent", ownedByCaller: true, generation: 1 },
                  }
                : { tabId: tab.tabId }
            ) as A;
          }),
  };
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const request = {
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
      };
      const created = yield* service.runCell({
        ...request,
        source: "return (await screen.openTab({url: 'https://example.test/'})).targetRef;",
      });
      expect(created.status).toBe("completed");
      const stop = yield* service.controlChanged({
        kind: "stop",
        threadId: "thread",
        tabId: "temporary",
      });
      expect(stop.cleanupFailures).toBe(1);
      expect((yield* service.journalSnapshot(request))[0]?.receipt).toMatchObject({
        method: "close_tab",
        journalState: "unknown",
        category: "unknown_outcome",
        evidence: ["cleanup_failed:close_ephemeral", "tab:temporary"],
      });
      const next = yield* service.runCell({ ...request, source: "return 1;" });
      // Stop between cells ends the tab's authority; the idle child keeps the thread's values.
      expect(next.truncated).not.toContain("context_reset");
      expect(
        next.journal.some((entry) =>
          entry.receipt.evidence.includes("cleanup_failed:close_ephemeral"),
        ),
      ).toBe(true);
      yield* service.finishTurn({ ...request, reason: "test" });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          tabHost,
          dispatcher: tabHost,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  });
});

it.live.each([
  { changeKind: "private", title: "private mode" },
  { changeKind: "takeover", title: "takeover" },
  { changeKind: "stop", title: "tab close" },
] as const)(
  "$title authority notification cuts an in-flight browser wait before input",
  ({ changeKind }) =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      let changed:
        | ((change: { kind: typeof changeKind; threadId: string; tabId: string }) => void)
        | undefined;
      let clicks = 0;
      const serviceLayer = ScreenRunService.layerWithRuntime({
        browser: {
          onAuthorityChange: (listener) => {
            changed = listener;
            return () => {
              changed = undefined;
            };
          },
        },
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: (call) =>
            call.method === "select_tab"
              ? Effect.succeed({
                  value: {
                    targetRef: {
                      id: "tab-target",
                      kind: "tab" as const,
                      environmentId: "env",
                      runId: "run",
                      turnId: "turn",
                      generation: 0,
                    },
                    tab: { tabId: "tab" },
                  },
                  category: "confirmed" as const,
                  evidence: ["bound"],
                })
              : call.method === "wait_for"
                ? Deferred.succeed(offered, undefined).pipe(
                    Effect.flatMap(() => Deferred.await(held)),
                    Effect.as({
                      value: { status: "met" },
                      category: "confirmed" as const,
                      evidence: ["met"],
                    }),
                  )
                : Effect.sync(() => {
                    clicks++;
                    return { category: "confirmed" as const, evidence: ["clicked"] };
                  }),
        },
      }).pipe(Layer.provide(NodeServices.layer));
      return yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const running = yield* service
          .runCell({
            runId: "run",
            turnId: "turn",
            threadId: "thread",
            environmentId: "env",
            invocation: context.invocation,
            source:
              "const tab = await screen.tab({tabId: 'tab'}); await tab.waitFor({text: 'ready'}); await tab.click({}); return true;",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(offered);
        expect(changed).toBeDefined();
        changed?.({ kind: changeKind, threadId: "thread", tabId: "tab" });
        const outcome = yield* Fiber.join(running);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure).toMatchObject({ code: "stopped", effectStarted: false });
        yield* Deferred.succeed(held, undefined);
        expect(clicks).toBe(0);
        const stale = yield* service
          .runCell({
            runId: "run",
            turnId: "turn",
            threadId: "thread",
            environmentId: "env",
            invocation: context.invocation,
            source: `return await screen.click({targetRef: ${JSON.stringify({
              id: "tab-target",
              kind: "tab",
              environmentId: "env",
              runId: "run",
              turnId: "turn",
              generation: 0,
            })}});`,
          })
          .pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
        if (stale._tag === "Failure") expect(stale.failure.code).toBe("stale_reference");
        yield* service.finishTurn({
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          reason: "test",
        });
      }).pipe(Effect.provide(serviceLayer));
    }),
);

it.live("desktop private authority notification cuts an active screen cell", () =>
  Effect.gen(function* () {
    const offered = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    type AuthorityListener = Parameters<
      NonNullable<ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0];
    let notify: AuthorityListener | undefined;
    const leases = yield* ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases)({
          proxy: undefined,
          currentControl: () => Effect.succeedNone,
          onAuthorityChange: (listener: AuthorityListener) => {
            notify = listener;
            return () => {
              notify = undefined;
            };
          },
        }),
      ),
    );
    const layer = ScreenRunService.layerWithRuntime({
      leases,
      invocation: {
        command: process.execPath,
        entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      },
      assetResolver: () => resolveScreenRuntimeAsset("dev"),
      dispatcher: {
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () =>
          Deferred.succeed(offered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(held)),
            Effect.as({ value: true, category: "confirmed" as const }),
          ),
      },
    }).pipe(Layer.provide(NodeServices.layer));
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const running = yield* service
        .runCell({
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source: "return await screen.list_apps();",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(offered);
      expect(notify).toBeDefined();
      notify?.({ kind: "private", threadId: "thread" as ThreadId, controlId: "control" });
      const outcome = yield* Fiber.join(running);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure).toMatchObject({ code: "stopped", effectStarted: false });
      yield* Deferred.succeed(held, undefined);
      yield* service.finishTurn({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.live("Stop during slow tab cleanup fails a cell that caught its dispatched input", () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("temporary"),
    title: "Page",
    url: "https://example.test/",
    owner: "agent" as const,
    ownedByCaller: true,
    controlGeneration: 1,
  };
  let opened = false;
  return Effect.gen(function* () {
    const navigating = yield* Deferred.make<void>();
    const navigateHeld = yield* Deferred.make<void>();
    const closeHeld = yield* Deferred.make<void>();
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed(opened ? [tab] : []),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        request.operation === "navigate"
          ? Deferred.succeed(navigating, undefined).pipe(
              Effect.flatMap(() => Deferred.await(navigateHeld)),
              Effect.as({ tabId: tab.tabId } as A),
            )
          : request.operation === "close"
            ? Deferred.await(closeHeld).pipe(Effect.as({ tabId: tab.tabId } as A))
            : Effect.sync(() => {
                if (request.operation === "open") opened = true;
                return (
                  request.operation === "status"
                    ? {
                        tabId: tab.tabId,
                        url: tab.url,
                        control: { owner: "agent", ownedByCaller: true, generation: 1 },
                      }
                    : { tabId: tab.tabId }
                ) as A;
              }),
    };
    type AuthorityListener = Parameters<
      NonNullable<ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0];
    let notify: AuthorityListener | undefined;
    const leases = yield* ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases)({
          proxy: undefined,
          currentControl: () => Effect.succeedNone,
          onAuthorityChange: (listener: AuthorityListener) => {
            notify = listener;
            return () => {
              notify = undefined;
            };
          },
        }),
      ),
    );
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const running = yield* service
        .runCell({
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source: [
            "const tab = await screen.openTab({url: 'https://example.test/'});",
            "try { await tab.navigate('https://example.test/next'); } catch {}",
            "return 'caught';",
          ].join("\n"),
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(navigating);
      notify?.({ kind: "stop", threadId: "thread" as ThreadId, controlId: "control" });
      const outcome = yield* Fiber.join(running);
      yield* Deferred.succeed(navigateHeld, undefined);
      yield* Deferred.succeed(closeHeld, undefined);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.code).toBe("unknown_outcome");
      yield* service.finishTurn({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          leases,
          tabHost,
          dispatcher: tabHost,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  });
});

it.live("terminal run cleanup is exact and a queued user message invalidates old handles", () => {
  let runAStatus: "waiting" | "completed" = "waiting";
  let binding = 0;
  const orchestratorLayer = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadProjection: () =>
      Effect.sync(
        () =>
          ({
            runs: [
              { id: "run-a", status: runAStatus },
              { id: "run-b", status: "running" },
            ],
          }) as unknown as OrchestrationV2ThreadProjection,
      ),
    getThreadRecords: (() =>
      Effect.sync(
        () =>
          ({
            runs: [
              { id: "run-a", status: runAStatus },
              { id: "run-b", status: "running" },
            ],
          }) as unknown as OrchestrationV2ThreadProjection,
      )) as never,
  });
  const serviceLayer = ScreenRunService.layerWithRuntime({
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
    dispatcher: {
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: (call) =>
        Effect.succeed(
          call.method === "select_tab"
            ? {
                value: {
                  targetRef: {
                    id: `binding-${++binding}`,
                    kind: "tab" as const,
                    environmentId: "env",
                    runId: call.runId,
                    turnId: call.turnId,
                    generation: 0,
                  },
                  tab: { tabId: "tab" },
                },
                category: "confirmed" as const,
                evidence: ["bound"],
              }
            : { value: { tree: "fresh" }, category: "confirmed" as const, evidence: ["observed"] },
        ),
    },
  });
  const event = (type: "run.updated" | "message.updated", payload: unknown) =>
    ({
      type,
      threadId: "thread",
      payload,
    }) as OrchestrationV2DomainEvent;
  const request = {
    turnId: "turn",
    threadId: "thread",
    environmentId: "env",
    invocation: context.invocation,
  };
  return Effect.gen(function* () {
    const screen = yield* ScreenRunService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* screen.runCell({ ...request, runId: "run-a", source: "return 1;" });
    const firstB = yield* screen.runCell({
      ...request,
      runId: "run-b",
      source: "return (await screen.tab({tabId: 'tab'})).targetRef;",
    });
    yield* handleScreenRunEvent({
      screen,
      orchestrator,
      event: event("run.updated", { id: "run-a", status: "waiting" }),
    });
    runAStatus = "completed";
    yield* handleScreenRunEvent({
      screen,
      orchestrator,
      event: event("run.updated", { id: "run-a", status: "completed" }),
    });
    const closedA = yield* screen
      .runCell({ ...request, runId: "run-a", source: "return 2;" })
      .pipe(Effect.result);
    expect(closedA._tag).toBe("Failure");
    const survivingB = yield* screen.runCell({ ...request, runId: "run-b", source: "return 3;" });
    expect(survivingB.value).toBe(3);
    yield* handleScreenRunEvent({
      screen,
      orchestrator,
      event: event("message.updated", { id: "queued-message", role: "user", runId: "queued-run" }),
    });
    const stale = yield* screen
      .runCell({
        ...request,
        runId: "run-b",
        source: `return await screen.observe({targetRef: ${JSON.stringify(firstB.value)}});`,
      })
      .pipe(Effect.result);
    expect(stale._tag).toBe("Failure");
    if (stale._tag === "Failure") expect(stale.failure.code).toBe("stale_reference");
    const fresh = yield* screen.runCell({
      ...request,
      runId: "run-b",
      source: "return (await screen.tab({tabId: 'tab'})).targetRef;",
    });
    expect(fresh.value).toMatchObject({ id: "binding-2" });
    yield* screen.finishTurn({ ...request, runId: "run-b", reason: "test" });
  }).pipe(
    Effect.provide(
      Layer.merge(serviceLayer, orchestratorLayer).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live.each(["new message", "turn end"] as const)(
  "%s domain event cuts an active screen cell",
  (trigger) =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      let status: "running" | "completed" = "running";
      const orchestratorLayer = Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () =>
          Effect.sync(
            () => ({ runs: [{ id: "run", status }] }) as unknown as OrchestrationV2ThreadProjection,
          ),
        getThreadRecords: (() =>
          Effect.sync(
            () => ({ runs: [{ id: "run", status }] }) as unknown as OrchestrationV2ThreadProjection,
          )) as never,
      });
      const serviceLayer = ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: (call) =>
            call.method === "select_tab"
              ? Effect.succeed({
                  value: {
                    targetRef: {
                      id: "tab-target",
                      kind: "tab" as const,
                      environmentId: "env",
                      runId: "run",
                      turnId: "turn",
                      generation: 0,
                    },
                    tab: { tabId: "tab" },
                  },
                  category: "confirmed" as const,
                })
              : Deferred.succeed(offered, undefined).pipe(
                  Effect.flatMap(() => Deferred.await(held)),
                  Effect.as({ value: true, category: "confirmed" as const }),
                ),
        },
      });
      return yield* Effect.gen(function* () {
        const screen = yield* ScreenRunService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const running = yield* screen
          .runCell({
            runId: "run",
            turnId: "turn",
            threadId: "thread",
            environmentId: "env",
            invocation: context.invocation,
            source:
              "const tab = await screen.tab({tabId: 'tab'}); return await tab.waitFor({text: 'ready'});",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(offered);
        if (trigger === "turn end") status = "completed";
        const event = (type: "message.updated" | "run.updated", payload: unknown) =>
          ({ type, threadId: "thread", payload }) as OrchestrationV2DomainEvent;
        yield* handleScreenRunEvent({
          screen,
          orchestrator,
          event:
            trigger === "new message"
              ? event("message.updated", { id: "message", role: "user" })
              : event("run.updated", { id: "run", status: "completed" }),
        });
        const outcome = yield* Fiber.join(running);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure).toMatchObject({
            code: "stopped",
            effectStarted: false,
            safety: { possibleCommit: false },
          });
        yield* Deferred.succeed(held, undefined);
        const stale = yield* screen
          .runCell({
            runId: "run",
            turnId: "turn",
            threadId: "thread",
            environmentId: "env",
            invocation: context.invocation,
            source: `return await screen.click({targetRef: ${JSON.stringify({
              id: "tab-target",
              kind: "tab",
              environmentId: "env",
              runId: "run",
              turnId: "turn",
              generation: 0,
            })}});`,
          })
          .pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
        if (stale._tag === "Failure")
          expect(stale.failure.code).toBe(trigger === "turn end" ? "stale_run" : "stale_reference");
        yield* screen.finishTurn({
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          reason: "test",
        });
      }).pipe(
        Effect.provide(
          Layer.merge(serviceLayer, orchestratorLayer).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }),
);
