// @effect-diagnostics schemaSyncInEffect:off preferSchemaOverJson:off - Frames are bounded before decode; JSON size is measured for the pipe.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  type ActionOutcomeSafety,
  ScreenHostCall,
  ScreenImage as ScreenImageSchema,
  type ScreenHostReply,
  type ScreenImage,
  type ScreenImageMetadata,
  type ScreenSurfaceAvailability,
  type ScreenActionOutcome,
  type ScreenEffectReceipt,
  type ScreenJournalEntry,
  type ScreenRunError,
  type ScreenRunLimits,
  type ScreenTargetRef,
  type ScreenBindingHints,
} from "@goat/contracts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { ScreenCursorPhases } from "../cua/ScreenCursorPhases.ts";
import { isScreenRead, screenActionSafety, screenFailureSafety } from "./ScreenActionOutcome.ts";
const isScreenImageSchema = Schema.is(ScreenImageSchema);

const decodeOptionScreenHostCall = Schema.decodeUnknownOption(ScreenHostCall);

export interface ScreenHostContext {
  readonly runId: string;
  readonly turnId: string;
  readonly cellId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly invocation: McpThreadInvocationScope;
  readonly limits: ScreenRunLimits;
  readonly bindingHints?: ScreenBindingHints;
}

export interface ScreenHostDispatchResult {
  readonly safety?: ActionOutcomeSafety;
  readonly value?: unknown;
  readonly image?: ScreenImage;
  readonly imageMetadata?: ScreenImageMetadata;
  readonly category: ScreenEffectReceipt["category"];
  readonly evidence?: readonly string[];
  readonly outcome?: ScreenActionOutcome;
}

export interface ScreenHostDispatcher {
  readonly availability: (
    context: ScreenHostContext,
  ) => Effect.Effect<readonly ScreenSurfaceAvailability[]>;
  readonly dispatch: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
}

interface CellState {
  closed: boolean;
  cutoffReason?: ScreenRunError["code"];
  readonly cutoff: AbortController;
  calls: number;
  pending: number;
  lastCallId: number;
  journal: ScreenJournalEntry[];
  images: ScreenImage[];
  metadata: ScreenImageMetadata[];
  truncated: string[];
  retainedBytes: number;
  // Counted apart from the journal so a full journal cannot hide an input whose effect may have started.
  effectsStarted: number;
  /** The first call that failed; the cell's later calls do not run. */
  haltedBy?: number;
}

const failure = (code: ScreenRunError["code"], callId?: number): ScreenRunError => ({
  code,
  ...(callId === undefined ? {} : { callId }),
  effectStarted: false,
  nextStep: "Refresh the screen target and retry if appropriate.",
});
const refused = (call: ScreenHostCall, error: ScreenRunError): ScreenHostReply => ({
  t: "reply",
  runId: call.runId,
  cellId: call.cellId,
  callId: call.callId,
  outcome: "error",
  error,
});
/** Results that did not do what was asked stop the rest of the cell, as errors do. */
const FAILED_CATEGORIES: ReadonlySet<ScreenEffectReceipt["category"]> = new Set([
  "partial",
  "suspected_noop",
  "refused",
]);
const notRun = (callId: number, haltedBy: number): ScreenRunError => ({
  ...failure("not_run", callId),
  nextStep: `Call ${haltedBy} in this cell failed, so this call did not run. Observe in a new cell before acting again.`,
});
const imageSize = (image: ScreenImage) => Buffer.from(image.bytes, "base64").byteLength;
const key = (runId: string, turnId: string, cellId: string) =>
  `${runId}\u0000${turnId}\u0000${cellId}`;

/** Room left for an observation's tree once the reply envelope and `reserveBytes` are paid for. */
export const observationReplyBudget = (
  call: ScreenHostCall,
  limits: ScreenRunLimits,
  reserveBytes = 0,
): number => {
  const envelope = JSON.stringify({
    t: "reply",
    runId: call.runId,
    cellId: call.cellId,
    callId: call.callId,
    outcome: "ok",
    value: null,
  });
  return Math.min(
    limits.treeBytes,
    limits.returnBytes - (Buffer.byteLength(envelope) - 4) - reserveBytes,
  );
};

export class ScreenHostBridge {
  private readonly cells = new Map<string, CellState>();
  private readonly invalidTargets = new Map<string, Set<string>>();
  private readonly turnTargets = new Map<string, Set<string>>();
  private readonly targetRefs = new Map<string, ScreenTargetRef>();
  private readonly cellTargets = new Map<string, Set<string>>();
  private readonly closedCells = new Map<string, Set<string>>();
  private readonly fencedTurns = new Set<string>();
  private readonly targetGates = new Map<string, Semaphore.Semaphore>();
  private dispatcher: ScreenHostDispatcher | undefined;
  private readonly cursorPhases: ScreenCursorPhases | undefined;

  constructor(cursorPhases?: ScreenCursorPhases) {
    this.cursorPhases = cursorPhases;
  }

  setDispatcher(dispatcher: ScreenHostDispatcher): void {
    this.dispatcher = dispatcher;
  }

  availability = Effect.fn("ScreenHostBridge.availability")(function* (
    this: ScreenHostBridge,
    context: ScreenHostContext,
  ) {
    if (this.dispatcher) return yield* this.dispatcher.availability(context);
    // Before a desktop or preview dispatcher is installed, neither surface has a host.
    return [
      { kind: "app" as const, available: false, reason: "no_lease" as const },
      { kind: "tab" as const, available: false, reason: "no_host" as const },
    ];
  });

  private cell(context: ScreenHostContext): CellState {
    const id = key(context.runId, context.turnId, context.cellId);
    let state = this.cells.get(id);
    if (!state) {
      state = {
        closed: false,
        cutoff: new AbortController(),
        calls: 0,
        pending: 0,
        lastCallId: 0,
        journal: [],
        images: [],
        metadata: [],
        truncated: [],
        retainedBytes: 0,
        effectsStarted: 0,
      };
      this.cells.set(id, state);
    }
    return state;
  }

  handle = Effect.fn("ScreenHostBridge.handle")(function* (
    this: ScreenHostBridge,
    raw: unknown,
    context: ScreenHostContext,
  ) {
    const decoded = decodeOptionScreenHostCall(raw);
    if (Option.isNone(decoded)) return undefined;
    const call = decoded.value;
    const turn = `${context.runId}\u0000${context.turnId}`;
    const state = this.cell(context);
    const record = (
      category: ScreenJournalEntry["receipt"]["category"],
      journalState: ScreenJournalEntry["receipt"]["journalState"],
      dispatched: boolean,
      evidence: readonly string[] = [],
      safety = screenActionSafety(call, "refused", false),
    ): number | undefined => {
      if (state.journal.length >= context.limits.journalEntries) {
        if (!state.truncated.includes("journal")) state.truncated.push("journal");
        return undefined;
      }
      const index = state.journal.length;
      state.journal.push({
        sequence: state.journal.length + 1,
        truncated: false,
        receipt: {
          safety,
          callId: call.callId,
          method: call.method,
          ...(call.targetRef ? { targetId: call.targetRef.id } : {}),
          journalState,
          category,
          dispatched,
          evidence: evidence.slice(0, 16).map((line) => line.slice(0, 200)),
        },
      });
      return index;
    };
    // The first failure stops the cell's later calls; calls already dispatched keep their outcome.
    const halt = () => {
      if (state.haltedBy === undefined) state.haltedBy = call.callId;
    };
    const notRunEvidence = (error: ScreenRunError) =>
      error.code === "not_run" && state.haltedBy !== undefined
        ? [`not_run:after_call:${state.haltedBy}`]
        : [];
    const deny = (error: ScreenRunError) => {
      const receipts = state.journal.slice(-15).map((entry) => entry.receipt);
      const safety = screenFailureSafety(call, error);
      record("refused", "settled", false, notRunEvidence(error), safety);
      halt();
      return refused(call, { ...error, safety, receipts });
    };
    if (
      this.fencedTurns.has(turn) ||
      this.closedCells.get(turn)?.has(context.cellId) ||
      state.closed ||
      call.runId !== context.runId ||
      call.turnId !== context.turnId ||
      call.cellId !== context.cellId
    )
      return deny(failure("stopped", call.callId));
    if (call.callId <= state.lastCallId) return deny(failure("invalid_argument", call.callId));
    state.lastCallId = call.callId;
    // After a failure, reads still run so the cell can observe what the failed call did.
    const halted = state.haltedBy !== undefined && !isScreenRead(call.method);
    if (halted) return deny(notRun(call.callId, state.haltedBy ?? call.callId));
    if (++state.calls > context.limits.callsPerCell)
      return deny({
        ...failure("call_limit", call.callId),
        limit: { name: "callsPerCell", maximum: context.limits.callsPerCell },
      });
    if (state.pending >= context.limits.pendingCalls)
      return deny({
        ...failure("pending_limit", call.callId),
        limit: { name: "pendingCalls", maximum: context.limits.pendingCalls },
      });
    // An effect without a receipt slot could finish unseen, so a full journal refuses new calls.
    if (state.journal.length >= context.limits.journalEntries)
      return deny({
        ...failure("call_limit", call.callId),
        limit: { name: "journalEntries", maximum: context.limits.journalEntries },
      });
    if (call.method === "type_text" || call.method === "set_value") {
      const first = Array.isArray(call.args) ? call.args[0] : undefined;
      const text =
        first && typeof first === "object" && !Array.isArray(first) && "text" in first
          ? first.text
          : undefined;
      if (typeof text === "string" && Buffer.byteLength(text, "utf8") > context.limits.argBytes)
        return deny({
          ...failure("text_limit", call.callId),
          limit: { name: "argBytes", maximum: context.limits.argBytes },
        });
    }
    if (
      !call.targetRef &&
      ![
        "list_apps",
        "list_windows",
        "bind_app",
        "launch_app",
        "list_tabs",
        "select_tab",
        "open_tab",
      ].includes(call.method)
    )
      return deny(failure("target_missing", call.callId));
    if (call.targetRef) {
      let touched = this.turnTargets.get(turn);
      if (!touched) {
        touched = new Set();
        this.turnTargets.set(turn, touched);
      }
      if (!touched.has(call.targetRef.id) && touched.size >= 4096) {
        this.fencedTurns.add(turn);
        return deny(failure("output_limit", call.callId));
      }
      touched.add(call.targetRef.id);
      this.targetRefs.set(call.targetRef.id, call.targetRef);
      const cellId = key(context.runId, context.turnId, context.cellId);
      let cellTargets = this.cellTargets.get(cellId);
      if (!cellTargets) this.cellTargets.set(cellId, (cellTargets = new Set()));
      cellTargets.add(call.targetRef.id);
    }
    if (
      call.targetRef &&
      (call.targetRef.runId !== context.runId ||
        call.targetRef.turnId !== context.turnId ||
        call.targetRef.environmentId !== context.environmentId ||
        this.invalidTargets.get(turn)?.has(call.targetRef.id))
    )
      return deny(failure("stale_reference", call.callId));
    const admittedIndex = record("unverifiable", "admitted", false);
    let callDispatched = false;
    const settle = (
      category: ScreenJournalEntry["receipt"]["category"],
      journalState: ScreenJournalEntry["receipt"]["journalState"] = "settled",
      dispatched?: boolean,
      evidence: readonly string[] = [],
      safety?: ActionOutcomeSafety,
      refusal: Pick<ScreenRunError, "refused" | "detail" | "app" | "holderThreadId"> & {
        readonly outcome?: ScreenActionOutcome;
      } = {},
    ) => {
      if (admittedIndex === undefined) return;
      const entry = state.journal[admittedIndex];
      if (!entry) return;
      state.journal[admittedIndex] = {
        ...entry,
        receipt: {
          ...entry.receipt,
          ...(safety ? { safety } : {}),
          category,
          journalState,
          dispatched: dispatched ?? entry.receipt.dispatched,
          evidence: evidence.slice(0, 16).map((line) => line.slice(0, 200)),
          ...refusal,
        },
      };
    };
    let ownFailure: ScreenRunError | undefined;
    const refusalOf = ({ refused: reason, detail, app, holderThreadId }: ScreenRunError) => ({
      ...(reason === undefined ? {} : { refused: reason }),
      ...(detail === undefined ? {} : { detail }),
      ...(app === undefined ? {} : { app }),
      ...(holderThreadId === undefined ? {} : { holderThreadId }),
    });
    const failCell = (error: ScreenRunError) => {
      const safety = screenFailureSafety(call, error);
      ownFailure = { ...error, safety, effectStarted: safety.possibleCommit };
      settle(
        safety.possibleCommit ? "unknown_outcome" : "refused",
        safety.possibleCommit ? "unknown" : "settled",
        error.effectStarted,
        notRunEvidence(error),
        safety,
        refusalOf(error),
      );
      halt();
    };
    const bridge = this;
    const dispatch = Effect.gen(function* () {
      if (state.closed || state.cutoff.signal.aborted)
        return yield* Effect.fail(failure("stopped", call.callId));
      if (state.haltedBy !== undefined && !isScreenRead(call.method))
        return yield* Effect.fail(notRun(call.callId, state.haltedBy));
      if (call.targetRef?.kind === "tab") {
        if (!context.invocation.reauthorize) {
          bridge.cutCellNow(context.runId, context.turnId, context.cellId, "permission_denied");
          return yield* Effect.fail(failure("permission_denied", call.callId));
        }
        const check = yield* context.invocation.reauthorize([]).pipe(Effect.result);
        if (check._tag === "Failure" || !context.invocation.capabilities.has("preview")) {
          bridge.cutCellNow(context.runId, context.turnId, context.cellId, "permission_denied");
          return yield* Effect.fail(failure("permission_denied", call.callId));
        }
      }
      if (state.closed || state.cutoff.signal.aborted)
        return yield* Effect.fail(failure("stopped", call.callId));
      if (state.haltedBy !== undefined && !isScreenRead(call.method))
        return yield* Effect.fail(notRun(call.callId, state.haltedBy));
      if (!bridge.dispatcher) return yield* Effect.fail(failure("unavailable", call.callId));
      callDispatched = true;
      state.effectsStarted++;
      settle(
        "unknown_outcome",
        "dispatched",
        true,
        [],
        screenActionSafety(call, "indeterminate", true),
      );
      const outcome = yield* bridge.dispatcher.dispatch(call, context);
      const unverified = outcome.category === "confirmed" && !outcome.evidence?.length;
      const category = unverified ? "unverifiable" : outcome.category;
      const safety = unverified
        ? screenActionSafety(call, "indeterminate", true)
        : (outcome.safety ??
          screenActionSafety(
            call,
            category === "confirmed"
              ? "completed"
              : category === "refused"
                ? "refused"
                : category === "suspected_noop"
                  ? "unapplied"
                  : category === "partial"
                    ? "partial"
                    : "indeterminate",
            category !== "refused",
          ));
      // An unverifiable write is a success that may have committed; the receipt says so.
      if (FAILED_CATEGORIES.has(category) && safety.writeStatus !== "not_applicable")
        return yield* Effect.fail({
          ...failure(safety.possibleCommit ? "unknown_outcome" : "downstream_failure", call.callId),
          effectStarted: safety.possibleCommit,
          safety,
        });
      if (!outcome.image) {
        const bytes = yield* Effect.try({
          try: () => Buffer.byteLength(JSON.stringify(outcome.value) ?? ""),
          catch: () => ({
            ...failure("downstream_failure", call.callId),
            effectStarted: callDispatched,
            safety,
          }),
        });
        if (bytes > context.limits.returnBytes)
          return yield* Effect.fail({
            ...failure("output_limit", call.callId),
            effectStarted: callDispatched,
            safety,
            limit: { name: "returnBytes" as const, maximum: context.limits.returnBytes },
          });
      }
      return { ...outcome, category, safety };
    });
    const guardedDispatch = dispatch.pipe(
      Effect.tapError((error) => Effect.sync(() => failCell(error))),
    );
    let effect = guardedDispatch;
    if (call.targetRef) {
      let gate = this.targetGates.get(call.targetRef.id);
      if (!gate) {
        gate = Semaphore.makeUnsafe(1);
        this.targetGates.set(call.targetRef.id, gate);
      }
      effect = gate.withPermits(1)(guardedDispatch);
      if (this.cursorPhases) effect = this.cursorPhases.track(call.targetRef, call.callId, effect);
    }
    state.pending++;
    const cutoff = Effect.callback<never, ScreenRunError>((resume) => {
      const onAbort = () => resume(Effect.fail(failure("stopped", call.callId)));
      if (state.cutoff.signal.aborted) onAbort();
      else state.cutoff.signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => state.cutoff.signal.removeEventListener("abort", onAbort));
    });
    const result = yield* Effect.raceFirst(effect, cutoff).pipe(
      Effect.result,
      Effect.ensuring(
        Effect.sync(() => {
          state.pending--;
        }),
      ),
    );
    if (ownFailure) {
      if (callDispatched && !ownFailure.effectStarted) state.effectsStarted--;
      return refused(call, { ...ownFailure, callId: call.callId });
    }
    if (state.closed) {
      const dispatched = callDispatched;
      const safety = screenActionSafety(call, dispatched ? "indeterminate" : "refused", dispatched);
      settle(
        dispatched ? "unknown_outcome" : "refused",
        dispatched ? "unknown" : "settled",
        dispatched,
        [],
        safety,
      );
      return refused(call, {
        ...failure(dispatched ? "unknown_outcome" : (state.cutoffReason ?? "stopped"), call.callId),
        effectStarted: dispatched,
        safety,
      });
    }
    if (result._tag === "Failure") {
      if (callDispatched && !result.failure.effectStarted) state.effectsStarted--;
      const safety = screenFailureSafety(call, result.failure);
      settle(
        result.failure.effectStarted ? "unknown_outcome" : "refused",
        result.failure.effectStarted ? "unknown" : "settled",
        result.failure.effectStarted,
        [],
        safety,
        refusalOf(result.failure),
      );
      halt();
      return refused(call, { ...result.failure, safety, callId: call.callId });
    }
    let value = result.success.value;
    const image = result.success.image;
    const metadata = result.success.imageMetadata;
    if (image && metadata) {
      if (
        image.callId !== call.callId ||
        metadata.callId !== call.callId ||
        image.imageRef !== metadata.imageRef ||
        image.observationId !== metadata.observationId ||
        image.regionId !== metadata.regionId ||
        image.targetId !== metadata.targetId ||
        !isScreenImageSchema(image)
      ) {
        settle("unverifiable");
        const error = {
          ...failure("downstream_failure", call.callId),
          effectStarted: callDispatched,
          safety: result.success.safety,
        };
        failCell(error);
        return refused(call, { ...error, safety: screenFailureSafety(call, error) });
      }
      const size = imageSize(image);
      if (size > context.limits.imageBytes) {
        state.metadata.push({ ...metadata, omitted: true });
        state.truncated.push(`image:${metadata.imageRef}`);
      } else {
        while (state.retainedBytes + size > context.limits.imageBytes) {
          const old = state.images.shift();
          if (!old) break;
          state.retainedBytes -= imageSize(old);
          const index = state.metadata.findIndex((item) => item.imageRef === old.imageRef);
          const previous = state.metadata[index];
          if (previous) state.metadata[index] = { ...previous, omitted: true };
          state.truncated.push(`image:${old.imageRef}`);
        }
        state.images.push(image);
        state.retainedBytes += size;
        state.metadata.push(metadata);
      }
      const stripImage = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(stripImage);
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (record.bytes === image.bytes) {
            const { bytes: _bytes, ...rest } = record;
            return { ...rest, ...metadata };
          }
          return Object.fromEntries(
            Object.entries(record).map(([name, part]) => [name, stripImage(part)]),
          );
        }
        return item;
      };
      value = value === undefined ? metadata : stripImage(value);
    }
    const json = image ? JSON.stringify(value) : undefined;
    if (json !== undefined && Buffer.byteLength(json) > context.limits.returnBytes) {
      state.truncated.push("return");
      settle("unverifiable");
      const error = {
        ...failure("output_limit", call.callId),
        effectStarted: callDispatched,
        safety: result.success.safety,
        limit: { name: "returnBytes" as const, maximum: context.limits.returnBytes },
      };
      failCell(error);
      return refused(call, { ...error, safety: screenFailureSafety(call, error) });
    }
    const evidence = result.success.evidence ?? [];
    settle(
      result.success.category,
      "settled",
      undefined,
      evidence,
      result.success.safety,
      result.success.outcome ? { outcome: result.success.outcome } : {},
    );
    if (FAILED_CATEGORIES.has(result.success.category)) halt();
    return {
      t: "reply" as const,
      runId: call.runId,
      cellId: call.cellId,
      callId: call.callId,
      outcome: "ok" as const,
      category: result.success.category,
      ...(value === undefined ? {} : { value: value as NonNullable<ScreenHostReply["value"]> }),
    } satisfies ScreenHostReply;
  });

  takeCellImages = Effect.fn("ScreenHostBridge.takeCellImages")(function* (
    this: ScreenHostBridge,
    runId: string,
    turnId: string,
    cellId: string,
  ) {
    return this.takeCellImagesNow(runId, turnId, cellId);
  });

  takeCellImagesNow(runId: string, turnId: string, cellId: string) {
    const id = key(runId, turnId, cellId);
    const state = this.cells.get(id);
    this.cells.delete(id);
    return {
      images: state?.images ?? [],
      imageMetadata: state?.metadata ?? [],
      journal: state?.journal ?? [],
      truncated: state?.truncated ?? [],
      effectsStarted: state?.effectsStarted ?? 0,
    };
  }

  /** Targets the cell has called, so a change to one tab can spare a cell that never used it. */
  cellTargetIds(runId: string, turnId: string, cellId: string): ReadonlySet<string> {
    return this.cellTargets.get(key(runId, turnId, cellId)) ?? new Set();
  }

  cutCell = Effect.fn("ScreenHostBridge.cutCell")(function* (
    this: ScreenHostBridge,
    runId: string,
    turnId: string,
    cellId: string,
    reason: string,
  ) {
    this.cutCellNow(runId, turnId, cellId, reason);
  });

  cutCellNow(runId: string, turnId: string, cellId: string, reason?: string): void {
    const id = key(runId, turnId, cellId);
    const state = this.cells.get(id);
    if (state) {
      state.closed = true;
      if (reason === "permission_denied") state.cutoffReason = reason;
      state.cutoff.abort();
    }
    const turn = `${runId}\u0000${turnId}`;
    let closed = this.closedCells.get(turn);
    if (!closed) {
      closed = new Set();
      this.closedCells.set(turn, closed);
    }
    if (closed.size >= 4096) this.fencedTurns.add(turn);
    else closed.add(cellId);
    this.endCellTargets(runId, turnId, cellId, reason);
  }

  discardCell = Effect.fn("ScreenHostBridge.discardCell")(function* (
    this: ScreenHostBridge,
    runId: string,
    turnId: string,
    cellId: string,
    _reason: string,
  ) {
    this.discardCellNow(runId, turnId, cellId);
  });

  discardCellNow(runId: string, turnId: string, cellId: string): void {
    const id = key(runId, turnId, cellId);
    const state = this.cells.get(id);
    if (state) {
      state.closed = true;
      state.cutoff.abort();
    }
    this.endCellTargets(runId, turnId, cellId);
    this.cells.delete(id);
    const turn = `${runId}\u0000${turnId}`;
    let closed = this.closedCells.get(turn);
    if (!closed) {
      closed = new Set();
      this.closedCells.set(turn, closed);
    }
    if (closed.size >= 4096) this.fencedTurns.add(turn);
    else closed.add(cellId);
  }

  markUnawaitedNow(
    runId: string,
    turnId: string,
    cellId: string,
    callIds: readonly number[],
  ): void {
    const state = this.cells.get(key(runId, turnId, cellId));
    if (!state) return;
    const unawaited = new Set(callIds);
    for (let index = 0; index < state.journal.length; index++) {
      const entry = state.journal[index];
      if (!entry || !unawaited.has(entry.receipt.callId)) continue;
      state.journal[index] = {
        ...entry,
        receipt: {
          ...entry.receipt,
          category: "unknown_outcome",
          journalState: "unknown",
          ...(entry.receipt.dispatched
            ? { safety: screenActionSafety(entry.receipt, "indeterminate", true) }
            : {}),
        },
      };
    }
  }

  invalidateTarget = Effect.fn("ScreenHostBridge.invalidateTarget")(function* (
    this: ScreenHostBridge,
    runId: string,
    turnId: string,
    targetId: string,
    reason: string,
  ) {
    this.invalidateTargetNow(runId, turnId, targetId, reason);
  });

  invalidateTargetNow(runId: string, turnId: string, targetId: string, reason?: string): void {
    const turn = `${runId}\u0000${turnId}`;
    let invalid = this.invalidTargets.get(turn);
    if (!invalid) {
      invalid = new Set();
      this.invalidTargets.set(turn, invalid);
    }
    if (invalid.size >= 4096) this.fencedTurns.add(turn);
    else invalid.add(targetId);
    const ref = this.targetRefs.get(targetId);
    if (ref)
      this.cursorPhases?.ended(
        ref,
        reason === "takeover" ? "takeover" : reason === "private" ? "private" : "ended",
      );
  }

  finishTurn = Effect.fn("ScreenHostBridge.finishTurn")(function* (
    this: ScreenHostBridge,
    runId: string,
    turnId: string,
  ) {
    const turn = `${runId}\u0000${turnId}`;
    for (const targetId of this.turnTargets.get(turn) ?? []) {
      const ref = this.targetRefs.get(targetId);
      if (ref) this.cursorPhases?.ended(ref);
      this.targetRefs.delete(targetId);
    }
    this.cursorPhases?.finishTurn(runId, turnId);
    for (const cellId of this.cellTargets.keys())
      if (cellId.startsWith(`${turn}\u0000`)) this.cellTargets.delete(cellId);
    this.invalidTargets.delete(turn);
    this.closedCells.delete(turn);
    this.fencedTurns.delete(turn);
    for (const targetId of this.turnTargets.get(turn) ?? []) this.targetGates.delete(targetId);
    this.turnTargets.delete(turn);
    for (const cellId of this.cells.keys())
      if (cellId.startsWith(`${turn}\u0000`)) this.cells.delete(cellId);
  });

  private endCellTargets(runId: string, turnId: string, cellId: string, reason?: string): void {
    const id = key(runId, turnId, cellId);
    for (const targetId of this.cellTargets.get(id) ?? []) {
      const ref = this.targetRefs.get(targetId);
      if (ref)
        this.cursorPhases?.ended(
          ref,
          reason === "takeover" ? "takeover" : reason === "private" ? "private" : "ended",
        );
    }
    this.cellTargets.delete(id);
  }
}
