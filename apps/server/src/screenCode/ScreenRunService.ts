// @effect-diagnostics nodeBuiltinImport:off - Cell IDs are local, opaque UUIDs.
import * as NodeCrypto from "node:crypto";
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
  ScreenJournalEntry,
} from "@goat/contracts";
import {
  CommandId,
  ScreenRunError as ScreenRunErrorSchema,
  ScreenTargetRef,
  ThreadId,
} from "@goat/contracts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenCursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPhases as CursorPhases } from "../cua/ScreenCursorPhases.ts";
import { ScreenCursorPublisher, type ScreenCursorRoute } from "../cua/ScreenCursorPublisher.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
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
    /** Cuts matching cells and targets synchronously; controlChanged does the slower cleanup. */
    readonly fence: (input: {
      readonly threadId?: string;
      readonly tabId?: string;
      readonly controlId?: string;
    }) => Effect.Effect<void>;
    readonly controlChanged: (input: {
      readonly kind:
        | "stop"
        | "stopAll"
        | "pause"
        | "resume"
        | "takeover"
        | "handBack"
        | "private"
        | "newMessage"
        | "credentialRevoked";
      readonly threadId?: string;
      readonly tabId?: string;
      readonly controlId?: string;
    }) => Effect.Effect<{ readonly cleanupFailures: number }>;
    readonly journalSnapshot: (input: {
      readonly runId: string;
      readonly turnId: string;
    }) => Effect.Effect<readonly ScreenJournalEntry[]>;
    readonly finishRun: (input: {
      readonly threadId: string;
      readonly runId: string;
      readonly reason: string;
    }) => Effect.Effect<void, ScreenRunError>;
  }
>()("goat/screenCode/ScreenRunService") {
  static get layer() {
    return layerWithTabHost();
  }
  static readonly layerWithDispatcher = (dispatcher: ScreenHostDispatcher) =>
    Layer.effect(this, make({ dispatcher }));
  static readonly layerWithRuntime = (options: ScreenRuntimeOptions) =>
    Layer.effect(this, make(options));
}

type PreviewTargetHost =
  ReturnType<typeof makePreviewTargetHost> extends Effect.Effect<infer A, infer _E, infer _R>
    ? A
    : never;

export function layerWithTabHost() {
  return Layer.effect(
    ScreenRunService,
    Effect.gen(function* () {
      const primitiveChannel = yield* ComputerUsePrimitiveChannel;
      const leases = yield* ComputerUseLeases;
      const broker = yield* PreviewAutomationBroker;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const browser = yield* ServerBrowser.ServerBrowser;
      const cursorPublisher = yield* ScreenCursorPublisher;
      const desktopHost = createDesktopTargetHost({ primitiveChannel, leases });
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* make({
        primitiveChannel,
        leases,
        orchestrator,
        browser,
        dispatcher: createScreenDispatchRouter({
          app: desktopHost,
          tab: tabHost,
        }),
        desktopHost,
        tabHost,
        cursorPublisher,
      });
    }),
  );
}

interface ScreenRuntimeOptions {
  readonly primitiveChannel?: ComputerUsePrimitiveChannel["Service"];
  readonly leases?: ComputerUseLeases["Service"];
  readonly orchestrator?: Orchestrator.OrchestratorV2["Service"];
  readonly browser?: Pick<ServerBrowser.ServerBrowser["Service"], "onAuthorityChange">;
  readonly dispatcher?: ScreenHostDispatcher;
  readonly desktopHost?: DesktopTargetHost;
  readonly tabHost?: PreviewTargetHost;
  readonly cursorPhases?: ScreenCursorPhases;
  readonly cursorPublisher?: ScreenCursorPublisher["Service"];
  readonly invocation?: SelfInvocation;
  readonly assetResolver?: () => Effect.Effect<{ path: string; sha256: string }, ScreenRunError>;
  readonly scheduleDeadline?: (run: () => void, ms: number) => () => void;
}

const make = Effect.fn("ScreenRunService.make")(function* (options: ScreenRuntimeOptions = {}) {
  const invocation = options.invocation ?? (yield* resolveSelfInvocation());
  const orchestrator =
    options.orchestrator ??
    Option.getOrUndefined(yield* Effect.serviceOption(Orchestrator.OrchestratorV2));
  const callbackContext = yield* Effect.context();
  const publisher =
    options.cursorPublisher ??
    Option.getOrUndefined(yield* Effect.serviceOption(ScreenCursorPublisher));
  const routes = new Map<
    string,
    ScreenCursorRoute & { readonly runId: string; readonly turnId: string; readonly cellId: string }
  >();
  const deliveries = new Map<string, Promise<void>>();
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const publish = (event: import("@goat/contracts").AgentCursorEvent) => {
    const targetId = event.identity.targetId;
    const route = routes.get(targetId);
    if (route === undefined || publisher === undefined) return;
    const previous = deliveries.get(targetId) ?? Promise.resolve();
    const next = previous
      .then(() =>
        Effect.runPromiseWith(callbackContext)(
          publisher
            .publish(event, route)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("screen cursor publish failed", { cause }),
              ),
            ),
        ),
      )
      .catch(() => undefined);
    deliveries.set(targetId, next);
  };
  const cursorPhases =
    options.cursorPhases ?? (publisher !== undefined ? new CursorPhases(publish) : undefined);
  const runCallback = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
    Effect.runPromiseWith(callbackContext)(effect, signal ? { signal } : undefined);
  const limits = screenRunLimits();
  const bridge = new ScreenHostBridge(cursorPhases);
  if (options.dispatcher) {
    const dispatcher = options.dispatcher;
    bridge.setDispatcher({
      availability: dispatcher.availability,
      dispatch: (call, context) =>
        dispatcher.dispatch(call, context).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (
                call.method !== "bind_app" &&
                call.method !== "select_tab" &&
                call.method !== "open_tab"
              )
                return;
              const value = record(result.value);
              const ref = Schema.is(ScreenTargetRef)(result.value)
                ? result.value
                : value && Schema.is(ScreenTargetRef)(value.targetRef)
                  ? value.targetRef
                  : undefined;
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
                cellId: context.cellId,
              });
            }),
          ),
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
          ...(options.scheduleDeadline ? { scheduleDeadline: options.scheduleDeadline } : {}),
        }));
      }),
    );
  });
  const turns = new Map<string, { threadId: string; environmentId: string }>();
  const resetNext = new Set<string>();
  const closingTurns = new Set<string>();
  const endedRuns = new Set<string>();
  const activeCells = new Map<string, string>();
  const cleanupJournal = new Map<string, ScreenJournalEntry[]>();
  const turnKey = (runId: string, turnId: string) => `${runId}\u0000${turnId}`;
  const recordCleanupFailure = (runId: string, turnId: string, tabId?: string) => {
    const id = turnKey(runId, turnId);
    const entries = cleanupJournal.get(id) ?? [];
    if (entries.length >= 64) return;
    entries.push({
      sequence: entries.length + 1,
      truncated: false,
      receipt: {
        callId: 0,
        method: "close_tab",
        journalState: "unknown",
        category: "unknown_outcome",
        dispatched: true,
        evidence: [
          "cleanup_failed:close_ephemeral",
          ...(tabId ? [`tab:${tabId.slice(0, 80)}`] : []),
        ],
      },
    });
    cleanupJournal.set(id, entries);
    if (cleanupJournal.size > 1024) {
      const oldest = cleanupJournal.keys().next().value;
      if (oldest !== undefined) cleanupJournal.delete(oldest);
    }
  };
  // Cleanup runs after the tool reply, so a thread notice is where a person learns a tab stayed open.
  const noticeCleanupFailure = (threadId: string, runId: string, turnId: string, count: number) =>
    orchestrator
      ? orchestrator
          .dispatch({
            type: "thread.notice.record",
            commandId: CommandId.make(`server:screen-code-cleanup:${runId}:${turnId}:${count}`),
            threadId: ThreadId.make(threadId),
            recordKey: `screen-code-cleanup:${runId}`,
            message:
              count === 1
                ? "Screen code could not close a tab it opened. Close it by hand if it is still open."
                : `Screen code could not close ${count} tabs it opened. Close them by hand if they are still open.`,
            severity: "warning",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("screen code cleanup notice failed", { cause }),
            ),
            Effect.forkDetach,
            Effect.asVoid,
          )
      : Effect.void;
  const releaseForeground = Effect.fn("ScreenRunService.releaseForeground")(function* (
    threadId: string,
    targets: readonly string[],
  ) {
    if (!options.leases?.releaseForeground || !options.desktopHost) return;
    const controls = new Set(
      targets
        .map((targetId) => options.desktopHost?.controlIdForTarget(targetId))
        .filter((id): id is string => id !== undefined),
    );
    for (const controlId of controls)
      yield* options.leases.releaseForeground({ threadId: ThreadId.make(threadId), controlId });
  });
  // A Stop for one tab (a person's Stop or the tab closing) only reaches cells that used the tab.
  // Private mode, takeover, stopAll and desktop changes still cut the thread's active cell.
  const tabStop = (change: { kind?: string; tabId?: string; controlId?: string }) =>
    change.tabId !== undefined &&
    change.controlId === undefined &&
    (change.kind === undefined || change.kind === "stop");
  const cellUsesTab = (runId: string, turnId: string, cellId: string, tabId: string) => {
    const called = bridge.cellTargetIds(runId, turnId, cellId);
    for (const [targetId, route] of routes)
      if (
        route.runId === runId &&
        route.turnId === turnId &&
        route.tabId === tabId &&
        (route.cellId === cellId || called.has(targetId))
      )
        return true;
    return false;
  };
  const cutsCell = (
    change: { kind?: string; tabId?: string; controlId?: string },
    runId: string,
    turnId: string,
    cellId: string | undefined,
  ) =>
    cellId !== undefined &&
    (!tabStop(change) ||
      (change.tabId !== undefined && cellUsesTab(runId, turnId, cellId, change.tabId)));
  const fenceNow = (change: {
    kind?: string;
    threadId?: string;
    tabId?: string;
    controlId?: string;
  }) => {
    for (const [id, turn] of turns) {
      if (change.threadId !== undefined && turn.threadId !== change.threadId) continue;
      const [runId, turnId] = id.split("\u0000");
      if (!runId || !turnId) continue;
      const cellId = activeCells.get(id);
      const cut = cutsCell(change, runId, turnId, cellId);
      let touched = cut;
      if (cut && cellId) bridge.cutCellNow(runId, turnId, cellId, change.kind);
      for (const [targetId, route] of routes) {
        if (route.runId !== runId || route.turnId !== turnId) continue;
        if (!cut && change.tabId !== undefined && route.tabId !== change.tabId) continue;
        if (
          !cut &&
          change.controlId !== undefined &&
          options.desktopHost?.matchesControl(targetId, change.controlId) !== true
        )
          continue;
        touched = true;
        bridge.invalidateTargetNow(runId, turnId, targetId, change.kind);
        options.desktopHost?.invalidateTarget(targetId);
        options.tabHost?.invalidateTarget(targetId);
      }
      // A spared cell keeps its child, so its values survive into the next cell.
      if (touched && (cut || cellId === undefined)) resetNext.add(id);
    }
  };
  const service: ScreenRunService["Service"] = {
    runCell: Effect.fn("ScreenRunService.runCell")(function* (input: ScreenRunInput) {
      if (endedRuns.has(input.runId)) return yield* Effect.fail(fail("stale_run"));
      if (orchestrator) {
        const projection = yield* orchestrator
          .getThreadProjection(ThreadId.make(input.threadId))
          .pipe(Effect.option);
        const run = Option.isSome(projection)
          ? projection.value.runs.find((candidate) => candidate.id === input.runId)
          : undefined;
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
        return yield* Effect.fail({
          ...fail("source_limit"),
          limit: { name: "sourceBytes", maximum: cellLimits.sourceBytes },
        });
      const running = yield* getSupervisor();
      // Asset resolution can suspend while a terminal run event closes this run.
      if (endedRuns.has(input.runId)) return yield* Effect.fail(fail("stale_run"));
      if (orchestrator) {
        const projection = yield* orchestrator
          .getThreadProjection(ThreadId.make(input.threadId))
          .pipe(Effect.option);
        const run = Option.isSome(projection)
          ? projection.value.runs.find((candidate) => candidate.id === input.runId)
          : undefined;
        if (!run || !["preparing", "queued", "starting", "running", "waiting"].includes(run.status))
          return yield* Effect.fail(fail("stale_run"));
      }
      if (endedRuns.has(input.runId)) return yield* Effect.fail(fail("stale_run"));
      const cellId = NodeCrypto.randomUUID();
      const id = turnKey(input.runId, input.turnId);
      if (closingTurns.has(id)) return yield* Effect.fail(fail("stale_run"));
      const previous = turns.get(id);
      if (
        previous &&
        (previous.threadId !== input.threadId || previous.environmentId !== input.environmentId)
      )
        return yield* Effect.fail(fail("invalid_argument"));
      if (!previous)
        turns.set(id, {
          threadId: input.threadId,
          environmentId: input.environmentId,
        });
      if (input.bindingHints) options.tabHost?.setBindingHints(input, input.bindingHints);
      // Stop fences the tracked cell, so a second cell must never replace the one still running.
      if (activeCells.has(id)) return yield* Effect.fail(fail("pending_limit"));
      activeCells.set(id, cellId);
      // A cutoff or new message killed the child, so values the agent stored are gone; say so.
      const contextReset = input.resetValues !== true && resetNext.delete(id);
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
          input.resetValues === true || contextReset,
        )
        .pipe(
          Effect.mapError((cause) => ({
            ...fail(cause.code),
            effectStarted: cause.effectStarted === true,
            ...(cause.receipts === undefined ? {} : { receipts: cause.receipts.slice(-16) }),
            ...(cause.code === "wall_limit"
              ? { limit: { name: "cellWallMs", maximum: cellLimits.cellWallMs } }
              : cause.code === "live_children_limit"
                ? { limit: { name: "activeChildren", maximum: cellLimits.activeChildren } }
                : cause.code === "output_limit"
                  ? { limit: { name: "returnBytes", maximum: cellLimits.returnBytes } }
                  : {}),
          })),
          Effect.flatMap((result) => {
            const notices = cleanupJournal.get(id) ?? [];
            cleanupJournal.delete(id);
            const journal = [
              ...result.journal,
              ...notices.map((entry, index) => ({
                ...entry,
                sequence: result.journal.length + index + 1,
              })),
            ].slice(-64);
            return result.error && Schema.is(ScreenRunErrorSchema)(result.error)
              ? Effect.fail({
                  ...result.error,
                  receipts: journal.slice(-16).map((entry) => entry.receipt),
                })
              : Effect.succeed({
                  ...result,
                  journal,
                  ...(contextReset
                    ? { truncated: ["context_reset", ...result.truncated].slice(0, 64) }
                    : {}),
                });
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (activeCells.get(id) === cellId) activeCells.delete(id);
            }),
          ),
        );
    }),
    cutCell: Effect.fn("ScreenRunService.cutCell")(function* (input: {
      runId: string;
      turnId: string;
      cellId: string;
      reason: string;
    }) {
      yield* bridge.cutCell(input.runId, input.turnId, input.cellId, input.reason);
      if (options.primitiveChannel)
        yield* options.primitiveChannel.cancel(input.runId, input.turnId);
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
      options.tabHost?.invalidateTarget(input.targetId);
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
        if (options.primitiveChannel)
          yield* options.primitiveChannel.cancel(input.runId, input.turnId);
      }
      const closing = [...routes].filter(
        ([, route]) => route.runId === input.runId && route.turnId === input.turnId,
      );
      yield* releaseForeground(
        input.threadId,
        closing.map(([targetId]) => targetId),
      );
      const cleanup = options.tabHost
        ? yield* Effect.exit(options.tabHost.finishTurn(input))
        : undefined;
      const outcomes = cleanup && Exit.isSuccess(cleanup) ? cleanup.value : [];
      if (supervisor) yield* supervisor.finishTurn(input.runId, input.turnId, input.reason);
      yield* bridge.finishTurn(input.runId, input.turnId);
      yield* Effect.promise(() =>
        Promise.all(closing.map(([targetId]) => deliveries.get(targetId) ?? Promise.resolve())),
      );
      for (const [targetId] of closing) {
        routes.delete(targetId);
        deliveries.delete(targetId);
      }
      options.desktopHost?.finishTurn(input.runId, input.turnId);
      turns.delete(turnKey(input.runId, input.turnId));
      resetNext.delete(turnKey(input.runId, input.turnId));
      const failed = outcomes.filter((outcome) => outcome.status === "failed");
      for (const outcome of failed) recordCleanupFailure(input.runId, input.turnId, outcome.tabId);
      if (cleanup && !Exit.isSuccess(cleanup)) recordCleanupFailure(input.runId, input.turnId);
      const notices = cleanupJournal.get(id) ?? [];
      if (notices.length) {
        yield* noticeCleanupFailure(input.threadId, input.runId, input.turnId, notices.length);
        return yield* Effect.fail({
          code: "cleanup_failed",
          effectStarted: true,
          receipts: notices.slice(-16).map((entry) => entry.receipt),
          nextStep: "Inspect the affected tab and close it manually if needed.",
        } satisfies ScreenRunError);
      }
    }),
    resetValues: Effect.fn("ScreenRunService.resetValues")(function* (input: {
      runId: string;
      turnId: string;
    }) {
      resetNext.add(turnKey(input.runId, input.turnId));
    }),
    fence: Effect.fn("ScreenRunService.fence")(function* (input: {
      threadId?: string;
      tabId?: string;
      controlId?: string;
    }) {
      fenceNow(input);
    }),
    controlChanged: Effect.fn("ScreenRunService.controlChanged")(function* (input: {
      kind:
        | "stop"
        | "stopAll"
        | "pause"
        | "resume"
        | "takeover"
        | "handBack"
        | "private"
        | "newMessage"
        | "credentialRevoked";
      threadId?: string;
      tabId?: string;
      controlId?: string;
    }) {
      if (input.kind === "resume" || input.kind === "handBack") return { cleanupFailures: 0 };
      let cleanupFailures = 0;
      for (const [id, turn] of turns) {
        if (input.threadId !== undefined && turn.threadId !== input.threadId) continue;
        const [runId, turnId] = id.split("\u0000");
        if (!runId || !turnId) continue;
        const cellId = activeCells.get(id);
        const cut = cutsCell(input, runId, turnId, cellId);
        // With no cell running, the child holds only values, and a cutoff still resets them.
        const endsChild = cut || cellId === undefined;
        const affected = (
          targetId: string,
          route: ScreenCursorRoute & { runId: string; turnId: string; cellId: string },
        ) =>
          route.runId === runId &&
          route.turnId === turnId &&
          (input.tabId === undefined || route.tabId === input.tabId) &&
          (input.controlId === undefined ||
            options.desktopHost?.matchesControl(targetId, input.controlId) === true);
        if (
          !cut &&
          (input.tabId !== undefined || input.controlId !== undefined) &&
          ![...routes].some(([targetId, route]) => affected(targetId, route))
        )
          continue;
        if (cut && cellId) {
          yield* bridge.cutCell(runId, turnId, cellId, input.kind);
          if (options.primitiveChannel) yield* options.primitiveChannel.cancel(runId, turnId);
        }
        if (endsChild)
          yield* releaseForeground(
            turn.threadId,
            [...routes]
              .filter(([, route]) => route.runId === runId && route.turnId === turnId)
              .map(([targetId]) => targetId),
          );
        if (
          options.tabHost &&
          (input.kind === "stop" || input.kind === "stopAll" || input.kind === "credentialRevoked")
        ) {
          const before = cleanupFailures;
          const cleanup = yield* Effect.exit(
            options.tabHost.releaseControl({
              runId,
              turnId,
              ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
            }),
          );
          if (Exit.isSuccess(cleanup)) {
            for (const outcome of cleanup.value) {
              if (outcome.status !== "failed") continue;
              recordCleanupFailure(runId, turnId, outcome.tabId);
              cleanupFailures++;
            }
          } else {
            recordCleanupFailure(runId, turnId);
            cleanupFailures++;
          }
          if (cleanupFailures > before)
            yield* noticeCleanupFailure(turn.threadId, runId, turnId, cleanupFailures - before);
        }
        // An authority cutoff closes the child, so computation values reset even if the
        // changed target is unrelated to the active cell; the next cell must rebind.
        if (supervisor && endsChild) yield* supervisor.finishTurn(runId, turnId, input.kind);
        for (const [targetId, route] of routes) {
          if (!cut && !affected(targetId, route)) continue;
          if (route.runId !== runId || route.turnId !== turnId) continue;
          yield* bridge.invalidateTarget(runId, turnId, targetId, input.kind);
          options.desktopHost?.invalidateTarget(targetId);
          options.tabHost?.invalidateTarget(targetId);
        }
        if (endsChild) resetNext.add(id);
      }
      return { cleanupFailures };
    }),
    journalSnapshot: Effect.fn("ScreenRunService.journalSnapshot")(function* (input: {
      runId: string;
      turnId: string;
    }) {
      return [...(cleanupJournal.get(turnKey(input.runId, input.turnId)) ?? [])];
    }),
    finishRun: Effect.fn("ScreenRunService.finishRun")(function* (input: {
      threadId: string;
      runId: string;
      reason: string;
    }) {
      endedRuns.add(input.runId);
      if (endedRuns.size > 4096) {
        const oldest = endedRuns.values().next().value;
        if (oldest !== undefined) endedRuns.delete(oldest);
      }
      let failed: ScreenRunError | undefined;
      for (const [id, turn] of turns) {
        const [runId, turnId] = id.split("\u0000");
        if (runId !== input.runId || turn.threadId !== input.threadId || !turnId) continue;
        const result = yield* service
          .finishTurn({
            runId,
            turnId,
            threadId: turn.threadId,
            environmentId: turn.environmentId,
            reason: input.reason,
          })
          .pipe(Effect.result);
        if (result._tag === "Failure") failed = result.failure;
      }
      if (failed) return yield* Effect.fail(failed);
    }),
  };
  if (options.leases?.onAuthorityChange) {
    const unsubscribe = options.leases.onAuthorityChange((change) => {
      fenceNow(change);
      void runCallback(
        service
          .controlChanged(change)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("screen desktop cutoff failed", { cause }),
            ),
          ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  }
  if (options.browser?.onAuthorityChange) {
    const unsubscribe = options.browser.onAuthorityChange((change) => {
      // The agent's own close_tab reports a Stop for that tab; its dispatch releases the claim.
      if (change.kind === "stop" && options.tabHost?.isClosingOwnTab(change.threadId, change.tabId))
        return;
      fenceNow(change);
      void runCallback(
        service
          .controlChanged(change)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("screen browser cutoff failed", { cause }),
            ),
          ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  }
  return service;
});
