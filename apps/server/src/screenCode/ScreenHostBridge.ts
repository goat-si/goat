// @effect-diagnostics schemaSyncInEffect:off preferSchemaOverJson:off - Frames are bounded before decode; JSON size is measured for the pipe.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
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
import { shortcutLabel } from "../cua/ScreenCellRow.ts";
import {
  mergeTerminal,
  terminalFailure,
  type ComputerUseTerminalReason,
} from "../cua/ComputerUseTerminal.ts";
import {
  callTerminalError,
  finalScreenReply,
  isScreenRead,
  screenActionSafety,
  screenFailureSafety,
} from "./ScreenActionOutcome.ts";
import { outcomeSentence } from "./DesktopInputGuards.ts";
import { applyObservedEffect } from "./ScreenObservedEffect.ts";
import { BatchGroups, dispatchInTurn } from "./ScreenBatchGroups.ts";
import { failure, imageSize, key, notRun, refused, replyTargetId } from "./ScreenHostFailures.ts";
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
  readonly observedWindow?: string;
  readonly observedBaseline?: string;
  readonly evidence?: readonly string[];
  readonly warnings?: readonly string[];
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
  /**
   * Calls of one batch group, in order, as one trip where the host can. It returns an outcome for
   * each call from the first that ran; calls past the end of the list did not run. It marks each
   * call dispatched right before that call can reach the driver.
   */
  readonly dispatchBatch?: (
    calls: ReadonlyArray<ScreenHostCall>,
    context: ScreenHostContext,
    markDispatched: (index: number) => void,
  ) => Effect.Effect<ReadonlyArray<Exit.Exit<ScreenHostDispatchResult, ScreenRunError>>>;
}

interface CellState {
  closed: boolean;
  cutoffReason?: ScreenRunError["code"];
  paused?: boolean;
  readonly cutoff: AbortController;
  calls: number;
  pending: number;
  lastCallId: number;
  journal: ScreenJournalEntry[];
  pendingObserved: Map<string, Array<{ index: number; window: string; baseline: string }>>;
  images: ScreenImage[];
  metadata: ScreenImageMetadata[];
  truncated: string[];
  retainedBytes: number;
  // Counted apart from the journal so a full journal cannot hide an input whose effect may have started.
  effectsStarted: number;
  /** The first call that failed after its write may have landed; the cell's later input does not run. */
  haltedBy?: number;
  readonly batches: BatchGroups;
}

/** Results that did not do what was asked; a write that answers one fails its call. */
const FAILED_CATEGORIES: ReadonlySet<ScreenEffectReceipt["category"]> = new Set([
  "partial",
  "suspected_noop",
  "refused",
]);
// A tab wait's deadline answer must still reach the cell process before the cell ends.
const WAIT_REPLY_RESERVE_MS = 100;
export { observationReplyBudget } from "./ScreenHostReplyBudget.ts";

export class ScreenHostBridge {
  private readonly cells = new Map<string, CellState>();
  private readonly invalidTargets = new Map<string, Set<string>>();
  private readonly turnTargets = new Map<string, Set<string>>();
  private readonly targetRefs = new Map<string, ScreenTargetRef>();
  private readonly cellTargets = new Map<string, Set<string>>();
  /**
   * Each cell's targets in first-use order and the shortcut labels of its key presses, kept past a
   * cut until the cell's result takes them, for its timeline row.
   */
  private readonly cellFacts = new Map<
    string,
    { readonly targets: string[]; readonly keys: Map<number, string> }
  >();
  private readonly closedCells = new Map<string, Set<string>>();
  private readonly terminalCells = new Map<string, ComputerUseTerminalReason>();
  private readonly fencedTurns = new Set<string>();
  private readonly targetGates = new Map<string, Semaphore.Semaphore>();
  private dispatcher: ScreenHostDispatcher | undefined;
  terminalObserver?: (context: ScreenHostContext, reason: ComputerUseTerminalReason) => void;
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
      const terminal = this.terminalCells.get(id);
      state = {
        closed: false,
        ...(terminal === undefined ? {} : { cutoffReason: terminal }),
        cutoff: new AbortController(),
        calls: 0,
        pending: 0,
        lastCallId: 0,
        journal: [],
        pendingObserved: new Map(),
        images: [],
        metadata: [],
        truncated: [],
        retainedBytes: 0,
        effectsStarted: 0,
        batches: new BatchGroups(),
      };
      this.cells.set(id, state);
    }
    return state;
  }
  private handleOnce = Effect.fn("ScreenHostBridge.handleOnce")(function* (
    this: ScreenHostBridge,
    raw: unknown,
    context: ScreenHostContext,
  ) {
    const decoded = decodeOptionScreenHostCall(raw);
    if (Option.isNone(decoded)) return undefined;
    const call = decoded.value;
    const turn = `${context.runId}\u0000${context.turnId}`;
    const state = this.cell(context);
    // A member of a batch group; any other call closes the cell's open group.
    const joined = state.batches.join(call);
    const slot = joined !== undefined && "late" in joined ? undefined : joined;
    const leave = () => {
      if (slot !== undefined) state.batches.withdraw(slot, notRun);
    };
    const record = (
      category: ScreenJournalEntry["receipt"]["category"],
      journalState: ScreenJournalEntry["receipt"]["journalState"],
      dispatched: boolean,
      evidence: readonly string[] = [],
      safety = screenActionSafety(call, "refused", false),
      outcome: { readonly outcome?: ScreenActionOutcome } = {},
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
          ...outcome,
        },
      });
      return index;
    };
    // A failed write that may have changed the page stops the cell's later input, since the cell
    // has not seen that change; a refusal that sent nothing, or a failed read, leaves the cell free.
    const halt = (safety: ActionOutcomeSafety) => {
      if (safety.possibleCommit && state.haltedBy === undefined) state.haltedBy = call.callId;
    };
    const notRunEvidence = (error: ScreenRunError) =>
      error.code === "not_run" && state.haltedBy !== undefined
        ? [`not_run:after_call:${state.haltedBy}`]
        : [];
    // Tab input reports its dispatch and effect apart, on failures as on success.
    const axes = (dispatch: ScreenActionOutcome["dispatch"]) =>
      (call.targetRef?.kind === "tab" || call.method === "open_tab") && !isScreenRead(call.method)
        ? { outcome: { dispatch, effect: "unknown" as const } }
        : {};
    const deny = (error: ScreenRunError) => {
      const receipts = state.journal.slice(-15).map((entry) => entry.receipt);
      const safety = screenFailureSafety(call, error);
      record("refused", "settled", false, notRunEvidence(error), safety, axes("refused"));
      leave();
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
      return deny(
        terminalFailure(
          state.cutoffReason === "stopped_by_person" || state.cutoffReason === "screen_locked"
            ? state.cutoffReason
            : undefined,
          isScreenRead(call.method) ? "list_apps" : call.method,
          call.args,
        ) ?? {
          ...failure("stopped", call.callId),
          ...(state.paused ? { nextStep: outcomeSentence("paused_unsent") } : {}),
        },
      );
    if (call.callId <= state.lastCallId) return deny(failure("invalid_argument", call.callId));
    state.lastCallId = call.callId;
    if (joined !== undefined && "late" in joined) return deny(notRun(call.callId, joined.late));
    // After a failure, reads still run so the cell can observe what the failed call did.
    const halted = state.haltedBy !== undefined && !isScreenRead(call.method);
    if (halted) return deny(notRun(call.callId, state.haltedBy ?? call.callId));
    if (++state.calls > context.limits.callsPerCell)
      return deny({
        ...failure("call_limit", call.callId),
        limit: { name: "callsPerCell", maximum: context.limits.callsPerCell },
      });
    // A batch group takes one pending place, its first call's.
    if (state.pending >= context.limits.pendingCalls && !(slot !== undefined && slot.index > 0))
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
        "list_menu_bar_extras",
        "bind_app",
        "launch_app",
        "list_tabs",
        "select_tab",
        "open_tab",
      ].includes(call.method)
    )
      // A snake_case global passes its arguments as given; without a targetRef it names no target.
      return deny({
        ...failure("invalid_argument", call.callId),
        message: `${call.method} takes the targetRef of a bound target.`,
        nextStep: `Call the target's own method, such as tab.close() or app.click(), or pass { targetRef: tab.targetRef } from screen.tab() or screen.app().`,
      });
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
      this.noteCellTarget(context, call.targetRef.id);
    }
    if (call.method === "press_key") {
      const label = shortcutLabel(Array.isArray(call.args) ? call.args[0] : undefined);
      if (label !== undefined) this.factsOf(context).keys.set(call.callId, label);
    }
    if (
      call.targetRef &&
      (call.targetRef.runId !== context.runId ||
        call.targetRef.turnId !== context.turnId ||
        call.targetRef.environmentId !== context.environmentId ||
        this.invalidTargets.get(turn)?.has(call.targetRef.id))
    )
      return deny(failure("stale_reference", call.callId));
    // Until the call settles, neither axis is known; a deadline may collect it as it stands.
    const admittedIndex = record("unverifiable", "admitted", false, [], undefined, axes("unknown"));
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
      // The admission's unknown axes stand only until the call settles on its own.
      const { outcome: _pending, ...settled } = entry.receipt;
      state.journal[admittedIndex] = {
        ...entry,
        receipt: {
          ...settled,
          ...(safety ? { safety } : {}),
          category,
          journalState,
          dispatched: dispatched ?? entry.receipt.dispatched,
          evidence: evidence.slice(0, 16).map((line) => line.slice(0, 200)),
          ...(category === "unknown_outcome"
            ? axes("unknown")
            : category === "refused"
              ? axes("refused")
              : {}),
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
      if (error.code === "stopped_by_person" || error.code === "screen_locked")
        this.terminalObserver?.(context, error.code);
      const safety =
        callTerminalError(error, undefined, call, error.effectStarted)?.safety ??
        screenFailureSafety(call, error);
      ownFailure = {
        ...error,
        safety,
        effectStarted: error.effectStarted || safety.possibleCommit,
      };
      settle(
        safety.possibleCommit ? "unknown_outcome" : "refused",
        safety.possibleCommit ? "unknown" : "settled",
        error.effectStarted,
        [...notRunEvidence(error), ...(error.evidence ?? [])],
        safety,
        refusalOf(error),
      );
      halt(safety);
    };
    const bridge = this;
    const dispatch = Effect.gen(function* () {
      if (state.closed || state.cutoff.signal.aborted)
        return yield* Effect.fail(failure("stopped", call.callId));
      if (state.haltedBy !== undefined && !isScreenRead(call.method))
        return yield* Effect.fail(notRun(call.callId, state.haltedBy));
      if (call.targetRef?.kind === "tab") {
        if (!context.invocation.reauthorize) {
          for (const targetId of bridge.turnTargets.get(turn) ?? [])
            bridge.invalidateTargetNow(
              context.runId,
              context.turnId,
              targetId,
              "permission_denied",
            );
          bridge.cutCellNow(context.runId, context.turnId, context.cellId, "permission_denied");
          return yield* Effect.fail(failure("permission_denied", call.callId));
        }
        const check = yield* context.invocation.reauthorize([]).pipe(Effect.result);
        if (check._tag === "Failure") {
          for (const targetId of bridge.turnTargets.get(turn) ?? [])
            bridge.invalidateTargetNow(
              context.runId,
              context.turnId,
              targetId,
              "permission_denied",
            );
          bridge.cutCellNow(context.runId, context.turnId, context.cellId, "permission_denied");
          return yield* Effect.fail(failure("permission_denied", call.callId));
        }
        if (!context.invocation.capabilities.has("preview")) {
          bridge.invalidateTargetNow(
            context.runId,
            context.turnId,
            call.targetRef.id,
            "permission_denied",
          );
          bridge.cutCellNow(
            context.runId,
            context.turnId,
            context.cellId,
            "target_permission_denied",
          );
          return yield* Effect.fail(failure("permission_denied", call.callId));
        }
      }
      if (state.closed || state.cutoff.signal.aborted)
        return yield* Effect.fail(failure("stopped", call.callId));
      if (state.haltedBy !== undefined && !isScreenRead(call.method))
        return yield* Effect.fail(notRun(call.callId, state.haltedBy));
      if (!bridge.dispatcher) return yield* Effect.fail(failure("unavailable", call.callId));
      const dispatcher = bridge.dispatcher;
      const markDispatched = () => {
        callDispatched = true;
        state.effectsStarted++;
        settle(
          "unknown_outcome",
          "dispatched",
          true,
          [],
          screenActionSafety(call, "indeterminate", true),
        );
      };
      if (slot !== undefined) {
        state.batches.ready(slot, markDispatched);
        if (slot.index === 0)
          yield* state.batches.run(slot, {
            blocked: (callId) =>
              state.closed || state.cutoff.signal.aborted
                ? failure("stopped", callId)
                : state.haltedBy === undefined
                  ? undefined
                  : notRun(callId, state.haltedBy),
            dispatch: (calls, mark) =>
              dispatcher.dispatchBatch?.(calls, context, mark) ??
              dispatchInTurn(
                calls,
                (each, index) =>
                  Effect.suspend(() => {
                    mark(index);
                    return dispatcher.dispatch(each, context);
                  }),
                FAILED_CATEGORIES,
              ),
            notRun,
          });
      } else markDispatched();
      const outcome = yield* slot === undefined
        ? dispatcher.dispatch(call, context)
        : Deferred.await(slot.outcome);
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
      if (
        FAILED_CATEGORIES.has(category) &&
        category !== "suspected_noop" &&
        safety.writeStatus !== "not_applicable"
      )
        return yield* Effect.fail({
          ...failure(safety.possibleCommit ? "unknown_outcome" : "downstream_failure", call.callId),
          effectStarted: safety.possibleCommit,
          safety,
          ...(outcome.evidence?.length ? { evidence: outcome.evidence.slice(0, 16) } : {}),
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
      if (category === "suspected_noop" && safety.writeStatus !== "not_applicable") halt(safety);
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
      // A group's first call holds the gate and the cursor phase for all of it; its other members
      // wait on that call so no queued member starts a phase before the group enters the gate.
      if (slot === undefined || slot.index === 0) {
        if (this.cursorPhases)
          effect = this.cursorPhases.track(
            call.targetRef,
            `${call.cellId}\u0000${call.callId}`,
            effect,
          );
        effect = gate.withPermits(1)(effect);
      }
    }
    // A batch group holds one pending place, its first call's, until that call settles.
    const holdsPlace = slot === undefined || slot.index === 0;
    if (holdsPlace) state.pending++;
    const cutoff = Effect.callback<never, ScreenRunError>((resume) => {
      const onAbort = () => resume(Effect.fail(failure("stopped", call.callId)));
      if (state.cutoff.signal.aborted) onAbort();
      else state.cutoff.signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => state.cutoff.signal.removeEventListener("abort", onAbort));
    });
    // A tab wait stuck behind its tab's other calls, its authorization or a browser that never
    // answers still answers inside its cell; it only reads, so it settles as a failed read.
    const waitDeadline =
      call.method === "wait_for" && call.targetRef?.kind === "tab"
        ? Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.sleep(Math.max(0, call.deadlineMillis - WAIT_REPLY_RESERVE_MS - now)),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                Effect.fail({
                  ...failure("deadline", call.callId),
                  nextStep: callDispatched
                    ? "The wait did not answer before this cell ends; the browser may still be checking. Observe in a new cell."
                    : "The wait could not start before this cell ends; observe or wait in a new cell.",
                  ...(callDispatched ? { evidence: ["wait_deadline:after_dispatch"] } : {}),
                }),
              ),
            ),
          )
        : Effect.never;
    const result = yield* Effect.raceFirst(Effect.raceFirst(effect, cutoff), waitDeadline).pipe(
      Effect.result,
      Effect.ensuring(
        Effect.sync(() => {
          leave();
          if (holdsPlace) state.pending--;
        }),
      ),
    );
    if (ownFailure) {
      if (callDispatched && !ownFailure.effectStarted) state.effectsStarted--;
      const terminal = callTerminalError(ownFailure, state.cutoffReason, call, callDispatched);
      return refused(call, { ...ownFailure, ...terminal, callId: call.callId });
    }
    if (state.closed) {
      const dispatched = callDispatched;
      const terminal =
        state.cutoffReason === "stopped_by_person" || state.cutoffReason === "screen_locked"
          ? terminalFailure(
              state.cutoffReason,
              isScreenRead(call.method) ? "list_apps" : call.method,
              call.args,
              dispatched,
            )
          : undefined;
      const safety =
        terminal?.safety ??
        screenActionSafety(call, dispatched ? "indeterminate" : "refused", dispatched);
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
        nextStep: state.paused
          ? outcomeSentence(dispatched ? "paused_dispatched" : "paused_unsent")
          : outcomeSentence(dispatched ? "unknown_outcome" : "refused"),
        ...terminal,
      });
    }
    if (result._tag === "Failure") {
      if (callDispatched && !result.failure.effectStarted) state.effectsStarted--;
      const safety = screenFailureSafety(call, result.failure);
      settle(
        result.failure.effectStarted ? "unknown_outcome" : "refused",
        result.failure.effectStarted ? "unknown" : "settled",
        result.failure.effectStarted,
        result.failure.evidence ?? [],
        safety,
        refusalOf(result.failure),
      );
      halt(safety);
      return refused(call, { ...result.failure, safety, callId: call.callId });
    }
    let value = result.success.value;
    // A bind or an opened tab names its target only in the reply.
    const boundRef = replyTargetId(value);
    if (boundRef !== undefined) this.noteCellTarget(context, boundRef);
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
      const existing = state.images.find(
        (item) => item.bytes === image.bytes && item.mimeType === image.mimeType,
      );
      const returnedMetadata = existing ? { ...metadata, imageRef: existing.imageRef } : metadata;
      const size = imageSize(image);
      if (existing) {
        state.metadata.push(returnedMetadata);
      } else if (size > context.limits.imageBytes) {
        state.metadata.push({ ...metadata, omitted: true });
        state.truncated.push(`image:${metadata.imageRef}`);
      } else {
        while (state.retainedBytes + size > context.limits.imageBytes) {
          const old = state.images.shift();
          if (!old) break;
          state.retainedBytes -= imageSize(old);
          state.metadata = state.metadata.map((item) =>
            item.imageRef === old.imageRef ? { ...item, omitted: true } : item,
          );
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
            return { ...rest, ...returnedMetadata };
          }
          return Object.fromEntries(
            Object.entries(record).map(([name, part]) => [
              name,
              name === "imageRef" && part === metadata.imageRef
                ? returnedMetadata.imageRef
                : stripImage(part),
            ]),
          );
        }
        return item;
      };
      value = value === undefined ? returnedMetadata : stripImage(value);
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
    const withEffect = applyObservedEffect(state, call, result.success, admittedIndex, value);
    if (Buffer.byteLength(JSON.stringify(withEffect) ?? "") <= context.limits.returnBytes)
      value = withEffect;
    settle(
      result.success.category,
      "settled",
      undefined,
      evidence,
      result.success.safety,
      result.success.outcome ? { outcome: result.success.outcome } : {},
    );
    return {
      t: "reply" as const,
      runId: call.runId,
      cellId: call.cellId,
      callId: call.callId,
      outcome: "ok" as const,
      category: result.success.category,
      ...(result.success.warnings?.length ? { warnings: result.success.warnings } : {}),
      ...(evidence.length
        ? { evidence: evidence.slice(0, 16).map((line) => line.slice(0, 200)) }
        : {}),
      ...(value === undefined ? {} : { value: value as NonNullable<ScreenHostReply["value"]> }),
    } satisfies ScreenHostReply;
  });

  handle = Effect.fn("ScreenHostBridge.handle")(function* (
    this: ScreenHostBridge,
    raw: unknown,
    context: ScreenHostContext,
  ) {
    const reply = yield* this.handleOnce(raw, context);
    const call = decodeOptionScreenHostCall(raw);
    if (Option.isNone(call)) return reply;
    const state = this.cell(context);
    return finalScreenReply(reply, call.value, state.cutoffReason, state.journal);
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
  private factsOf(context: Pick<ScreenHostContext, "runId" | "turnId" | "cellId">) {
    const id = key(context.runId, context.turnId, context.cellId);
    let facts = this.cellFacts.get(id);
    if (!facts) this.cellFacts.set(id, (facts = { targets: [], keys: new Map() }));
    return facts;
  }

  private noteCellTarget(
    context: Pick<ScreenHostContext, "runId" | "turnId" | "cellId">,
    targetId: string,
  ) {
    const { targets } = this.factsOf(context);
    if (!targets.includes(targetId) && targets.length < 64) targets.push(targetId);
  }

  /** What a finished cell acted on, in first-use order, and its key labels, even after a cut. */
  takeCellFacts(runId: string, turnId: string, cellId: string) {
    const id = key(runId, turnId, cellId);
    const facts = this.cellFacts.get(id) ?? { targets: [], keys: new Map<number, string>() };
    this.cellFacts.delete(id);
    return facts;
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
    if (reason === "stopped_by_person" || reason === "screen_locked") {
      const merged = mergeTerminal({ reason: this.terminalCells.get(id) }, { reason }).reason;
      if (merged !== undefined) this.terminalCells.set(id, merged);
    }
    const state = this.cells.get(id);
    if (state) {
      state.closed = true;
      const terminal = this.terminalCells.get(id);
      if (terminal !== undefined) state.cutoffReason = terminal;
      if (
        terminal === undefined &&
        (reason === "permission_denied" || reason === "target_permission_denied")
      )
        state.cutoffReason = "permission_denied";
      if (reason === "pause" || reason === "takeover" || reason === "waiting_for_human")
        state.paused = true;
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
    state?.cutoff.abort();
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
    if (state) state.closed = true;
    this.endCellTargets(runId, turnId, cellId);
    state?.cutoff.abort();
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
    for (const cellId of this.cellFacts.keys())
      if (cellId.startsWith(`${turn}\u0000`)) this.cellFacts.delete(cellId);
    this.invalidTargets.delete(turn);
    this.closedCells.delete(turn);
    for (const cellId of this.terminalCells.keys())
      if (cellId.startsWith(`${turn}\u0000`)) this.terminalCells.delete(cellId);
    this.fencedTurns.delete(turn);
    for (const targetId of this.turnTargets.get(turn) ?? []) this.targetGates.delete(targetId);
    this.turnTargets.delete(turn);
    for (const cellId of this.cells.keys())
      if (cellId.startsWith(`${turn}\u0000`)) this.cells.delete(cellId);
  });

  private endCellTargets(runId: string, turnId: string, cellId: string, reason?: string): void {
    const id = key(runId, turnId, cellId);
    const nonterminal =
      reason === undefined || reason === "unawaited" || reason === "target_permission_denied";
    for (const targetId of this.cellTargets.get(id) ?? []) {
      const ref = this.targetRefs.get(targetId);
      if (!ref) continue;
      if (nonterminal) this.cursorPhases?.endCell(ref, cellId);
      else
        this.cursorPhases?.ended(
          ref,
          reason === "takeover" ? "takeover" : reason === "private" ? "private" : "ended",
        );
    }
    this.cellTargets.delete(id);
  }
}
