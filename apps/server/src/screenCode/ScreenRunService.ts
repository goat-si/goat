// @effect-diagnostics nodeBuiltinImport:off - Cell IDs are local, opaque UUIDs.
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";
import type {
  ScreenBindingHints,
  ScreenRunLimits,
  ScreenRunResult,
  ScreenRunError,
} from "@goat/contracts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
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
  static readonly layer = Layer.effect(
    this,
    Effect.suspend(() => make()),
  );
  static readonly layerWithDispatcher = (dispatcher: ScreenHostDispatcher) =>
    Layer.effect(this, make({ dispatcher }));
  static readonly layerWithRuntime = (options: ScreenRuntimeOptions) =>
    Layer.effect(this, make(options));
}

interface ScreenRuntimeOptions {
  readonly dispatcher?: ScreenHostDispatcher;
  readonly invocation?: SelfInvocation;
  readonly assetResolver?: () => Effect.Effect<{ path: string; sha256: string }, ScreenRunError>;
}

const make = (options: ScreenRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const invocation = options.invocation ?? (yield* resolveSelfInvocation());
    const callbackContext = yield* Effect.context();
    const runCallback = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
      Effect.runPromiseWith(callbackContext)(effect, signal ? { signal } : undefined);
    const limits = screenRunLimits();
    const bridge = new ScreenHostBridge();
    if (options.dispatcher) bridge.setDispatcher(options.dispatcher);
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
