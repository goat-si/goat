// @effect-diagnostics nodeBuiltinImport:off - Cell IDs are local, opaque UUIDs.
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";
import type {
  ScreenBindingHints,
  ScreenRunLimits,
  ScreenRunResult,
  ScreenRunError,
} from "@goat/contracts";
import { ScreenTargetRef, ThreadId } from "@goat/contracts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenCursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPhases as CursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPublisher, type ScreenCursorRoute } from "../cua/ScreenCursorPublisher.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { createDesktopTargetHost, type DesktopTargetHost } from "./DesktopTargetHost.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenHostBridge, type ScreenHostDispatcher } from "./ScreenHostBridge.ts";
import { screenRunLimits, screenBytes } from "./ScreenRunLimits.ts";
import { resolveScreenRuntimeAsset, screenRuntimeLayout } from "./ScreenRuntimeAsset.ts";
import { createScreenRunSupervisor, type ScreenRunSupervisor } from "./ScreenRunSupervisor.ts";

export interface ScreenRunInput {
  readonly runId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly invocation: McpThreadInvocationScope;
  readonly source: string;
  readonly resetValues?: boolean;
  readonly limits?: Partial<ScreenRunLimits>;
  readonly bindingHints?: ScreenBindingHints;
}

const fail = (code: ScreenRunError["code"]): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep: "Refresh the screen run and retry if appropriate.",
});

export class ScreenRunService extends Context.Service<
  ScreenRunService,
  {
    readonly runCell: (input: ScreenRunInput) => Effect.Effect<ScreenRunResult, ScreenRunError>;
    readonly cutCell: (input: {
      runId: string;
      turnId: string;
      cellId: string;
      reason: string;
    }) => Effect.Effect<void>;
    readonly invalidateTarget: (input: {
      runId: string;
      turnId: string;
      targetId: string;
      reason: string;
    }) => Effect.Effect<void>;
    readonly finishTurn: (input: {
      runId: string;
      turnId: string;
      threadId: string;
      environmentId: string;
      reason: string;
    }) => Effect.Effect<void, ScreenRunError>;
    readonly resetValues: (input: { runId: string; turnId: string }) => Effect.Effect<void>;
    readonly controlChanged: (input: {
      readonly kind: "stop" | "stopAll" | "pause" | "resume" | "takeover" | "handBack" | "private" | "newMessage" | "credentialRevoked";
      readonly threadId?: string;
      readonly tabId?: string;
      readonly controlId?: string;
    }) => Effect.Effect<void>;
    readonly finishRun: (input: { readonly threadId: string; readonly runId: string; readonly reason: string }) => Effect.Effect<void, ScreenRunError>;
  }
>()("goat/screenCode/ScreenRunService") {
  static get layer() { return layerWithTabHost(); }
  static readonly layerWithDispatcher = (dispatcher: ScreenHostDispatcher) =>
    Layer.effect(this, make({ dispatcher }));
  static readonly layerWithRuntime = (options: ScreenRuntimeOptions) =>
    Layer.effect(this, make(options));
}

type PreviewTargetHost = ReturnType<typeof makePreviewTargetHost> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

export function layerWithTabHost() {
  return Layer.effect(
    ScreenRunService,
    Effect.gen(function* () {
      const primitiveChannel = yield* ComputerUsePrimitiveChannel;
      const leases = yield* ComputerUseLeases;
      const broker = yield* PreviewAutomationBroker;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const cursorPublisher = yield* ScreenCursorPublisher;
      const desktopHost = createDesktopTargetHost({ primitiveChannel, leases });
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* make({ primitiveChannel, leases, orchestrator, dispatcher: createScreenDispatchRouter({
        app: desktopHost,
        tab: tabHost,
      }), desktopHost, tabHost, cursorPublisher });
    }),
  );
}

interface ScreenRuntimeOptions {
  readonly primitiveChannel?: ComputerUsePrimitiveChannel["Service"];
  readonly leases?: ComputerUseLeases["Service"];
  readonly orchestrator?: Orchestrator.OrchestratorV2["Service"];
  readonly dispatcher?: ScreenHostDispatcher;
  readonly desktopHost?: DesktopTargetHost;
  readonly tabHost?: PreviewTargetHost;
  readonly cursorPhases?: ScreenCursorPhases;
  readonly cursorPublisher?: ScreenCursorPublisher["Service"];
  readonly invocation?: SelfInvocation;
  readonly assetResolver?: () => Effect.Effect<{ path: string; sha256: string }, ScreenRunError>;
}

const make = (options: ScreenRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const invocation = options.invocation ?? (yield* resolveSelfInvocation());
    const orchestrator = options.orchestrator ?? Option.getOrUndefined(yield* Effect.serviceOption(Orchestrator.OrchestratorV2));
    const callbackContext = yield* Effect.context();
    const publisher = options.cursorPublisher ?? Option.getOrUndefined(yield* Effect.serviceOption(ScreenCursorPublisher));
    const routes = new Map<string, ScreenCursorRoute & { readonly runId: string; readonly turnId: string }>();
    const deliveries = new Map<string, Promise<void>>();
    const record = (value: unknown): Record<string, unknown> | undefined =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
    const publish = (event: import("@goat/contracts").ComputerUseCursorEvent) => {
      const targetId = event.identity.targetId;
      const route = routes.get(targetId);
      if (route === undefined || publisher === undefined) return;
      const previous = deliveries.get(targetId) ?? Promise.resolve();
      const next = previous.then(() =>
        Effect.runPromiseWith(callbackContext)(publisher.publish(event, route).pipe(
          Effect.catchCause((cause) => Effect.logWarning("screen cursor publish failed", { cause })),
        )),
      ).catch(() => undefined);
      deliveries.set(targetId, next);
    };
    const cursorPhases = options.cursorPhases ?? (publisher !== undefined
      ? new CursorPhases(publish) : undefined);
    const runCallback = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
      Effect.runPromiseWith(callbackContext)(effect, signal ? { signal } : undefined);
    const limits = screenRunLimits();
    const bridge = new ScreenHostBridge(cursorPhases);
    if (options.dispatcher) {
      const dispatcher = options.dispatcher;
      bridge.setDispatcher({
        availability: dispatcher.availability,
        dispatch: (call, context) => dispatcher.dispatch(call, context).pipe(
          Effect.tap((result) => Effect.sync(() => {
            if (call.method !== "bind_app" && call.method !== "bind_tab" && call.method !== "open_tab") return;
            const value = record(result.value);
            const ref = Schema.is(ScreenTargetRef)(result.value)
              ? result.value
              : value && Schema.is(ScreenTargetRef)(value.targetRef) ? value.targetRef : undefined;
            if (ref === undefined) return;
            const tab = record(value?.tab);
            const tabId = typeof tab?.tabId === "string" ? tab.tabId : undefined;
            if (ref.kind === "tab" && tabId === undefined) return;
            routes.set(ref.id, {
              threadId: context.threadId,
              kind: ref.kind,
              ...(tabId === undefined ? {} : { tabId }),
              runId: context.runId,
              turnId: context.turnId,
            });
          })),
        ),
      });
    }
    let supervisor: ScreenRunSupervisor | undefined;
    const assetGate = yield* Semaphore.make(1);
    const getSupervisor = Effect.fn("ScreenRunService.getSupervisor")(function* () {
      return yield* assetGate.withPermits(1)(
        Effect.gen(function* () {
          if (supervisor) return supervisor;
          const asset = yield* (
            options.assetResolver?.() ??
              resolveScreenRuntimeAsset(screenRuntimeLayout(invocation), {
                executable: invocation.command,
              })
          );
          return (supervisor ??= createScreenRunSupervisor({
            asset,
            limits,
            hostBridge: bridge,
            invocation,
            runCallback,
          }));
        }),
      );
    });
    const turns = new Map<
      string,
      { threadId: string; environmentId: string; limits: ScreenRunLimits }
    >();
    const resetNext = new Set<string>();
    const closingTurns = new Set<string>();
    const activeCells = new Map<string, string>();
    const turnKey = (runId: string, turnId: string) => `${runId}\u0000${turnId}`;
    const releaseForeground = (threadId: string, targets: readonly string[]) =>
      Effect.gen(function* () {
        if (!options.leases?.releaseForeground || !options.desktopHost) return;
        const controls = new Set(targets.map((targetId) =>
          options.desktopHost?.controlIdForTarget(targetId)).filter((id): id is string => id !== undefined));
        for (const controlId of controls)
          yield* options.leases.releaseForeground({ threadId: ThreadId.make(threadId), controlId });
      });
    const service: ScreenRunService["Service"] = {
      runCell: Effect.fn("ScreenRunService.runCell")(function* (input: ScreenRunInput) {
        if (orchestrator) {
          const projection = yield* orchestrator.getThreadProjection(ThreadId.make(input.threadId))
            .pipe(Effect.option);
          const run = Option.isSome(projection)
            ? projection.value.runs.find((candidate) => candidate.id === input.runId) : undefined;
          if (!run || !["preparing", "queued", "starting", "running", "waiting"].includes(run.status))
            return yield* Effect.fail(fail("stale_run"));
        }
        let cellLimits: ScreenRunLimits;
        try {
          cellLimits = screenRunLimits(input.limits);
        } catch {
          return yield* Effect.fail(fail("invalid_argument"));
        }
        if (screenBytes(input.source) > cellLimits.sourceBytes)
          return yield* Effect.fail({ ...fail("source_limit"), limit: { name: "sourceBytes", maximum: cellLimits.sourceBytes } });
        const running = yield* getSupervisor();
        const cellId = randomUUID();
        const id = turnKey(input.runId, input.turnId);
        if (closingTurns.has(id)) return yield* Effect.fail(fail("stale_run"));
        const previous = turns.get(id);
        if (
          previous &&
          (previous.threadId !== input.threadId ||
            previous.environmentId !== input.environmentId ||
            Object.keys(cellLimits).some(
              (key) =>
                cellLimits[key as keyof ScreenRunLimits] !==
                previous.limits[key as keyof ScreenRunLimits],
            ))
        )
          return yield* Effect.fail(fail("invalid_argument"));
        if (!previous)
          turns.set(id, {
            threadId: input.threadId,
            environmentId: input.environmentId,
            limits: cellLimits,
          });
        if (input.bindingHints) options.tabHost?.setBindingHints(input, input.bindingHints);
        activeCells.set(id, cellId);
        return yield* running
          .runCell(
            {
              runId: input.runId,
              turnId: input.turnId,
              context: {
                runId: input.runId,
                turnId: input.turnId,
                cellId,
                threadId: input.threadId,
                environmentId: input.environmentId,
                invocation: input.invocation,
                limits: cellLimits,
                ...(input.bindingHints ? { bindingHints: input.bindingHints } : {}),
              },
            },
            input.source,
            input.resetValues === true || resetNext.delete(id),
          )
          .pipe(
            Effect.mapError((cause) => ({ ...fail(cause.code),
              ...(cause.code === "wall_limit" ? { limit: { name: "cellWallMs", maximum: cellLimits.cellWallMs } }
                : cause.code === "live_children_limit" ? { limit: { name: "activeChildren", maximum: cellLimits.activeChildren } }
                  : cause.code === "output_limit" ? { limit: { name: "returnBytes", maximum: cellLimits.returnBytes } }
                    : {}),
            })),
            Effect.ensuring(Effect.sync(() => {
              if (activeCells.get(id) === cellId) activeCells.delete(id);
            })),
          );
      }),
      cutCell: Effect.fn("ScreenRunService.cutCell")(function* (input: {
        runId: string;
        turnId: string;
        cellId: string;
        reason: string;
      }) {
        yield* bridge.cutCell(input.runId, input.turnId, input.cellId, input.reason);
        if (options.primitiveChannel) yield* options.primitiveChannel.cancel(input.runId, input.turnId);
        if (supervisor)
          yield* supervisor.cutCell(input.runId, input.turnId, input.cellId, input.reason);
      }),
      invalidateTarget: Effect.fn("ScreenRunService.invalidateTarget")(function* (input: {
        runId: string;
        turnId: string;
        targetId: string;
        reason: string;
      }) {
        yield* bridge.invalidateTarget(input.runId, input.turnId, input.targetId, input.reason);
        const delivery = deliveries.get(input.targetId);
        if (delivery !== undefined) yield* Effect.promise(() => delivery);
        routes.delete(input.targetId);
        deliveries.delete(input.targetId);
        options.desktopHost?.invalidateTarget(input.targetId);
      }),
      finishTurn: Effect.fn("ScreenRunService.finishTurn")(function* (input: {
        runId: string;
        turnId: string;
        threadId: string;
        environmentId: string;
        reason: string;
      }) {
        const id = turnKey(input.runId, input.turnId);
        closingTurns.add(id);
        if (closingTurns.size > 4096) {
          const oldest = closingTurns.values().next().value;
          if (oldest !== undefined) closingTurns.delete(oldest);
        }
        const cellId = activeCells.get(id);
        if (cellId) {
          yield* bridge.cutCell(input.runId, input.turnId, cellId, input.reason);
          if (options.primitiveChannel) yield* options.primitiveChannel.cancel(input.runId, input.turnId);
        }
        const closing = [...routes].filter(([, route]) =>
          route.runId === input.runId && route.turnId === input.turnId);
        yield* releaseForeground(input.threadId, closing.map(([targetId]) => targetId));
        const cleanup = options.tabHost
          ? yield* Effect.exit(options.tabHost.finishTurn(input)) : undefined;
        const outcomes = cleanup && Exit.isSuccess(cleanup) ? cleanup.value : [];
        if (supervisor) yield* supervisor.finishTurn(input.runId, input.turnId, input.reason);
        for (const [targetId] of closing) { routes.delete(targetId); deliveries.delete(targetId); }
        options.desktopHost?.finishTurn(input.runId, input.turnId);
        yield* bridge.finishTurn(input.runId, input.turnId);
        turns.delete(turnKey(input.runId, input.turnId));
        resetNext.delete(turnKey(input.runId, input.turnId));
        const failed = outcomes.filter((outcome) => outcome.status === "failed");
        if (failed.length || (cleanup && !Exit.isSuccess(cleanup))) return yield* Effect.fail({
          code: "cleanup_failed", effectStarted: true,
          receipts: failed.slice(0, 16).map((outcome, index) => ({
            callId: index, method: "close_tab" as const, journalState: "unknown" as const,
            category: "unknown_outcome" as const, dispatched: true,
            evidence: [`close_ephemeral:${outcome.tabId.slice(0, 80)}`],
          })),
          nextStep: "Inspect the affected tab and close it manually if needed.",
        } satisfies ScreenRunError);
      }),
      resetValues: Effect.fn("ScreenRunService.resetValues")(function* (input: {
        runId: string;
        turnId: string;
      }) {
        resetNext.add(turnKey(input.runId, input.turnId));
      }),
      controlChanged: Effect.fn("ScreenRunService.controlChanged")(function* (input: {
        kind: "stop" | "stopAll" | "pause" | "resume" | "takeover" | "handBack" | "private" | "newMessage" | "credentialRevoked";
        threadId?: string;
        tabId?: string;
        controlId?: string;
      }) {
        if (input.kind === "resume" || input.kind === "handBack") return;
        for (const [id, turn] of turns) {
          if (input.threadId !== undefined && turn.threadId !== input.threadId) continue;
          const [runId, turnId] = id.split("\u0000");
          if (!runId || !turnId) continue;
          const cellId = activeCells.get(id);
          const affected = (targetId: string, route: ScreenCursorRoute & { runId: string; turnId: string }) =>
            route.runId === runId && route.turnId === turnId &&
            (input.tabId === undefined || route.tabId === input.tabId) &&
            (input.controlId === undefined ||
              options.desktopHost?.matchesControl(targetId, input.controlId) === true);
          if (!cellId && (input.tabId !== undefined || input.controlId !== undefined) &&
              ![...routes].some(([targetId, route]) => affected(targetId, route))) continue;
          if (cellId) {
            yield* bridge.cutCell(runId, turnId, cellId, input.kind);
            if (options.primitiveChannel) yield* options.primitiveChannel.cancel(runId, turnId);
          }
          yield* releaseForeground(turn.threadId, [...routes].filter(([, route]) =>
            route.runId === runId && route.turnId === turnId).map(([targetId]) => targetId));
          if (options.tabHost && (input.kind === "stop" || input.kind === "stopAll" || input.kind === "credentialRevoked")) {
            const cleanup = yield* Effect.exit(options.tabHost.releaseControl({ runId, turnId,
              ...(input.tabId === undefined ? {} : { tabId: input.tabId }) }));
            if (!Exit.isSuccess(cleanup))
              yield* Effect.logWarning("screen tab claim release failed", { runId });
          }
          if (supervisor) yield* supervisor.finishTurn(runId, turnId, input.kind);
          for (const [targetId, route] of routes) {
            if (!cellId && !affected(targetId, route)) continue;
            if (route.runId !== runId || route.turnId !== turnId) continue;
            yield* bridge.invalidateTarget(runId, turnId, targetId, input.kind);
            options.desktopHost?.invalidateTarget(targetId);
          }
          resetNext.add(id);
        }
      }),
      finishRun: Effect.fn("ScreenRunService.finishRun")(function* (input: {
        threadId: string; runId: string; reason: string;
      }) {
        let failed: ScreenRunError | undefined;
        for (const [id, turn] of turns) {
          const [runId, turnId] = id.split("\u0000");
          if (runId !== input.runId || turn.threadId !== input.threadId || !turnId) continue;
          const result = yield* service.finishTurn({ runId, turnId, threadId: turn.threadId,
            environmentId: turn.environmentId, reason: input.reason }).pipe(Effect.result);
          if (result._tag === "Failure") failed = result.failure;
        }
        if (failed) return yield* Effect.fail(failed);
      }),
    };
    if (options.leases?.onAuthorityChange) {
      const unsubscribe = options.leases.onAuthorityChange((change) => {
        for (const [id, turn] of turns) {
          if (turn.threadId !== change.threadId) continue;
          const cellId = activeCells.get(id);
          const [runId, turnId] = id.split("\u0000");
          if (cellId && runId && turnId) bridge.cutCellNow(runId, turnId, cellId);
        }
        void runCallback(service.controlChanged(change).pipe(
          Effect.catchCause((cause) => Effect.logWarning("screen desktop cutoff failed", { cause })),
        ));
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }
    return service;
  });
