// @effect-diagnostics nodeBuiltinImport:off - Cell IDs are local, opaque UUIDs.
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import { ScreenTargetRef } from "@goat/contracts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenCursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPhases as CursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPublisher, type ScreenCursorRoute } from "../cua/ScreenCursorPublisher.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
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
    }) => Effect.Effect<void>;
    readonly resetValues: (input: { runId: string; turnId: string }) => Effect.Effect<void>;
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
      const cursorPublisher = yield* ScreenCursorPublisher;
      const desktopHost = createDesktopTargetHost({ primitiveChannel, leases });
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* make({ dispatcher: createScreenDispatchRouter({
        app: desktopHost,
        tab: tabHost,
      }), desktopHost, tabHost, cursorPublisher });
    }),
  );
}

interface ScreenRuntimeOptions {
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
    const turnKey = (runId: string, turnId: string) => `${runId}\u0000${turnId}`;
    return {
      runCell: Effect.fn("ScreenRunService.runCell")(function* (input: ScreenRunInput) {
        let cellLimits: ScreenRunLimits;
        try {
          cellLimits = screenRunLimits(input.limits);
        } catch {
          return yield* Effect.fail(fail("invalid_argument"));
        }
        if (screenBytes(input.source) > cellLimits.sourceBytes)
          return yield* Effect.fail(fail("resource_exhausted"));
        const running = yield* getSupervisor();
        const cellId = randomUUID();
        const id = turnKey(input.runId, input.turnId);
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
          .pipe(Effect.mapError((cause) => fail(cause.code)));
      }),
      cutCell: Effect.fn("ScreenRunService.cutCell")(function* (input: {
        runId: string;
        turnId: string;
        cellId: string;
        reason: string;
      }) {
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
        if (supervisor) yield* supervisor.finishTurn(input.runId, input.turnId, input.reason);
        yield* bridge.finishTurn(input.runId, input.turnId);
        const closing = [...routes].filter(([, route]) =>
          route.runId === input.runId && route.turnId === input.turnId);
        yield* Effect.promise(() => Promise.all(closing.map(([targetId]) => deliveries.get(targetId) ?? Promise.resolve())));
        for (const [targetId] of closing) { routes.delete(targetId); deliveries.delete(targetId); }
        options.desktopHost?.finishTurn(input.runId, input.turnId);
        if (options.tabHost) yield* options.tabHost.finishTurn(input);
        turns.delete(turnKey(input.runId, input.turnId));
        resetNext.delete(turnKey(input.runId, input.turnId));
      }),
      resetValues: Effect.fn("ScreenRunService.resetValues")(function* (input: {
        runId: string;
        turnId: string;
      }) {
        resetNext.add(turnKey(input.runId, input.turnId));
      }),
    };
  });
