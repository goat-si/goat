import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import {
  OPERATION_WAIT_MAX_MS,
  OperationError,
  type OperationKind,
  OperationRef,
  type OperationState,
  isTerminalOperationState,
} from "@goat/contracts/agentSurface/operation";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/ai";

import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { HandoffReader } from "../../operations/handoffReads.ts";
import { OPERATION_KINDS, type ToolCall } from "../../operations/kinds.ts";
import type { OperationTokens, VerifiedOperation } from "../../operations/OperationTokens.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { dispatchEnvelope } from "./dispatchEnvelope.ts";

const DEFAULT_WAIT_MS = 60_000;

export const OperationResult = Schema.Struct({
  operation: OperationRef,
  /** The kind's status (or cancel) tool's answer, as goat_call would return it. */
  result: Schema.optionalKey(AgentSurfaceResult),
  /** operation.wait only: the deadline came before the work finished. */
  timedOut: Schema.optionalKey(Schema.Boolean),
});
export type OperationResult = typeof OperationResult.Type;

const OperationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
  description: "The operationId from a goat_call result's meta.operation.",
});
const dependencies = [McpInvocationContext.McpInvocationContext, McpSchema.McpServerClient];
const operationTool = <E extends AgentSurfaceRegistryEntry, P extends Schema.Struct.Fields>(
  entry: E,
  parameters: P,
) =>
  Tool.make(entry.name as E["name"], {
    description: entry.description,
    parameters: Schema.Struct(parameters),
    success: OperationResult,
    failure: OperationError,
    dependencies,
  }).annotateMerge(agentSurfaceAnnotations(entry));

export const OperationReadTool = operationTool(agentSurfaceRegistry["operation.read"], {
  operationId: OperationId,
});
export const OperationWaitTool = operationTool(agentSurfaceRegistry["operation.wait"], {
  operationId: OperationId,
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(OPERATION_WAIT_MAX_MS),
    ).annotate({ description: "How long to wait, in ms. Defaults to 60000; at most 300000." }),
  ),
});
export const OperationCancelTool = operationTool(agentSurfaceRegistry["operation.cancel"], {
  operationId: OperationId,
});

/** A status read that came back needs_human is waiting on the handoff it names. */
const refOf = (
  operationId: string,
  kind: OperationKind,
  state: OperationState,
  result?: AgentSurfaceResult,
): OperationRef => {
  const spec = OPERATION_KINDS[kind];
  const waiting = result?.status === "needs_human" ? result.handoff.handoffId : undefined;
  return {
    operationId,
    kind,
    state: waiting === undefined ? state : "waiting_human",
    cancellable: spec.cancellable,
    ...(isTerminalOperationState(state) ? {} : { pollAfterMs: spec.pollAfterMs }),
    ...(waiting === undefined ? {} : { handoffId: waiting }),
  };
};

/**
 * operation.read, wait and cancel. Each verifies the handle, then runs the kind's existing
 * status or cancel tool through ToolDispatch, so the verb adds no authority of its own.
 */
export const makeOperations = (
  dispatch: ToolDispatch["Service"],
  tokens: OperationTokens,
  readHandoff: HandoffReader,
) => {
  const resolve = Effect.fn("Operation.resolve")(function* (operationId: string) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const handle = yield* tokens.verify(operationId, scope);
    const age = (yield* Clock.currentTimeMillis) - handle.issuedAtMs;
    if (age > OPERATION_KINDS[handle.kind].retentionMs)
      return yield* new OperationError({
        reason: "expired",
        message: "This operation is older than GOAT keeps its records. Read the work directly.",
      });
    return handle;
  });

  const readOnce = Effect.fn("Operation.readOnce")(function* (
    operationId: string,
    handle: VerifiedOperation,
  ) {
    const spec = OPERATION_KINDS[handle.kind];
    const source = spec.source(handle.nativeId);
    const viaTool = (call: ToolCall) => dispatchEnvelope(dispatch, call.tool, call.args, "read");
    let result: AgentSurfaceResult;
    if ("tool" in source) result = yield* viaTool(source.tool);
    else {
      result = yield* readHandoff(source.handoffId);
      // Once a person has acted, the work behind the handoff answers for itself.
      if (result.status === "ok" && source.then !== undefined) result = yield* viaTool(source.then);
    }
    const state = spec.state(result, handle.nativeId);
    return { operation: refOf(operationId, handle.kind, state, result), result };
  });

  const read = Effect.fn("Operation.read")(function* (input: { readonly operationId: string }) {
    return yield* readOnce(input.operationId, yield* resolve(input.operationId));
  });

  const wait = Effect.fn("Operation.wait")(function* (input: {
    readonly operationId: string;
    readonly timeoutMs?: number | undefined;
  }) {
    const handle = yield* resolve(input.operationId);
    const spec = OPERATION_KINDS[handle.kind];
    const deadline = (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? DEFAULT_WAIT_MS);
    let last: OperationResult | undefined;
    while (true) {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) break;
      // The deadline bounds the read too; timing out interrupts only this observer.
      const next = yield* readOnce(input.operationId, handle).pipe(
        Effect.timeoutOption(Duration.millis(remaining)),
      );
      if (Option.isNone(next)) break;
      last = next.value;
      // Finished, or GOAT cannot tell: another read would say the same.
      if (isTerminalOperationState(last.operation.state) || last.operation.state === "unknown")
        return last;
      const pause = Math.min(spec.pollAfterMs, deadline - (yield* Clock.currentTimeMillis));
      if (pause <= 0) break;
      yield* Effect.sleep(Duration.millis(pause));
    }
    return {
      ...(last ?? { operation: refOf(input.operationId, handle.kind, "unknown") }),
      timedOut: true,
    } satisfies OperationResult;
  });

  const cancel = Effect.fn("Operation.cancel")(function* (input: { readonly operationId: string }) {
    const handle = yield* resolve(input.operationId);
    const spec = OPERATION_KINDS[handle.kind];
    if (spec.cancel === undefined)
      return yield* new OperationError({
        reason: "not_cancellable",
        message: "This kind of work has no cancel path. Read it until it finishes.",
      });
    const current = yield* readOnce(input.operationId, handle);
    const call = spec.cancel(handle.nativeId, current.result);
    if (call === undefined)
      return yield* new OperationError({
        reason: "not_cancellable",
        message: "Nothing runs yet: a person has not approved this work. Read it again later.",
      });
    const result = yield* dispatchEnvelope(dispatch, call.tool, call.args, "destructive");
    const after = yield* readOnce(input.operationId, handle);
    return { operation: after.operation, result } satisfies OperationResult;
  });

  /** goat_call's handle for work its target accepted and has not finished. */
  const withOperation = Effect.fn("Operation.issue")(function* (
    entry: AgentSurfaceRegistryEntry,
    result: AgentSurfaceResult,
  ) {
    const kind: OperationKind | undefined = "operation" in entry ? entry.operation : undefined;
    if (kind === undefined) return result;
    const spec = OPERATION_KINDS[kind];
    const nativeId = spec.produce(result);
    if (nativeId === undefined) return result;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const operationId = yield* tokens.issue(kind, nativeId, scope);
    const operation = refOf(operationId, kind, spec.state(result, nativeId), result);
    return { ...result, meta: { ...result.meta, operation } } satisfies AgentSurfaceResult;
  });

  /** True when `entry` starts long work and no handle can be issued for it now. */
  const unready = (entry: AgentSurfaceRegistryEntry) =>
    "operation" in entry && entry.operation !== undefined
      ? tokens.ready.pipe(
          Effect.as(false),
          Effect.catch((error) =>
            Effect.logWarning("Could not load the operation signing key.", error).pipe(
              Effect.as(true),
            ),
          ),
        )
      : Effect.succeed(false);

  return { read, wait, cancel, withOperation, unready };
};
