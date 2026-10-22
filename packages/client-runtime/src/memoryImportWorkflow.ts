import {
  MEMORY_IMPORT_PREVIEW_MAX_ITEMS,
  MemoryImportRpcError,
  type MemoryCapacityDimension,
  type MemoryImportIssue,
  type MemoryImportOutcome,
  type MemoryImportFormat,
  type MemoryImportProviderInput,
  type MemoryImportProviderResult,
  type MemoryImportReceipt,
  type MemoryImportSourceId,
  type MemoryOperationId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { MemoryImportDestination, MemoryImportRecoveryStore } from "./memoryImportRecovery.ts";

const isMemoryImportRpcError = Schema.is(MemoryImportRpcError);

/** A short reason for a whole-request import refusal, for the settings UI. */
export function memoryImportIssueReason(issue: MemoryImportIssue): string {
  switch (issue) {
    case "unsupported_format":
      return "This provider's memory format is not supported.";
    case "source_missing":
      return "That memory store or profile is not on this device.";
    case "source_unreadable":
      return "The memory store could not be read.";
    case "invalid_utf8":
      return "A memory file is not valid text.";
    case "path_rejected":
      return "A memory file is outside the allowed location.";
    case "limit_exceeded":
      return `This folder has more than ${MEMORY_IMPORT_PREVIEW_MAX_ITEMS} items.`;
    case "source_changed":
      return "The source changed. Preview again before importing.";
    case "scope_unmapped":
      return "Items in projects/ need a project scope.";
    case "mapping_changed":
      return "The destination changed. Preview again before importing.";
    case "bootstrap_required":
      return "Set up memory on this device before importing.";
    case "secret_detected":
      return "Import stopped because sensitive content was found.";
    case "storage_failed":
      return "The import could not be saved.";
    case "operation_id_reused":
      return "This import request was already used. Preview again.";
    case "capacity_exceeded":
      return "Memory storage is full.";
  }
}

/** The typed refusal's reason, or null when the failure is not a memory-import error. */
export function memoryImportRequestFailureMessage(error: unknown): string | null {
  return isMemoryImportRpcError(error) ? memoryImportIssueReason(error.issue) : null;
}

type Apply = Extract<MemoryImportProviderInput, { action: "apply" }>;
type Preview = Extract<MemoryImportProviderResult, { action: "preview" }>;
export type MemoryImportSelection = Apply["items"][number];
export type MemoryImportFence = MemoryImportDestination & { readonly session: string };
export type MemoryImportPhase =
  | "idle"
  | "discovering"
  | "discovered"
  | "previewing"
  | "selecting"
  | "previewed"
  | "save_failed"
  | "saving"
  | "applying"
  | "checking"
  | "recovery"
  | "partial"
  | "completed"
  | "repreview";
export interface MemoryImportCounts {
  readonly outcomes: Readonly<Partial<Record<MemoryImportOutcome, number>>>;
  readonly issues: Readonly<Partial<Record<MemoryImportIssue, number>>>;
  readonly capacity: Readonly<Partial<Record<MemoryCapacityDimension, number>>>;
}
export interface MemoryImportChunkSummary extends MemoryImportCounts {
  readonly operationId: MemoryOperationId;
  readonly state: MemoryImportReceipt["state"];
}
export interface MemoryImportWorkflowState {
  readonly phase: MemoryImportPhase;
  readonly stopped: boolean;
  readonly settledChunks: number;
  readonly receipt: MemoryImportReceipt | null;
  readonly message: string | null;
  readonly chunkSummaries: readonly MemoryImportChunkSummary[];
  readonly totals: MemoryImportCounts;
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const emptyCounts = (): MemoryImportCounts => ({ outcomes: {}, issues: {}, capacity: {} });
export const initialMemoryImportWorkflowState: MemoryImportWorkflowState = freezeSnapshot({
  phase: "idle",
  stopped: false,
  settledChunks: 0,
  receipt: null,
  message: null,
  chunkSummaries: [],
  totals: emptyCounts(),
});
export type MemoryImportProgressEvent =
  | { readonly type: "stop"; readonly inFlight: boolean }
  | { readonly type: "receipt"; readonly receipt: MemoryImportReceipt }
  | { readonly type: "finish"; readonly totalChunks: number };

/** Pure progress reduction: stopping never turns an admitted receipt into cancellation. */
export function reduceMemoryImportProgress(
  state: MemoryImportWorkflowState,
  event: MemoryImportProgressEvent,
): MemoryImportWorkflowState {
  switch (event.type) {
    case "stop":
      return {
        ...state,
        stopped: true,
        phase: event.inFlight ? state.phase : "partial",
        message: "Stopped future chunks. An import already sent may still be applied.",
      };
    case "receipt": {
      const counts = emptyCounts();
      const outcomes = { ...counts.outcomes };
      const issues = { ...counts.issues };
      const capacity = { ...counts.capacity };
      for (const item of event.receipt.items) {
        outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
        if (item.issue !== undefined) issues[item.issue] = (issues[item.issue] ?? 0) + 1;
        if (item.capacity !== undefined) {
          const dimension = item.capacity.dimension;
          capacity[dimension] = (capacity[dimension] ?? 0) + 1;
        }
      }
      const summary: MemoryImportChunkSummary = {
        operationId: event.receipt.operationId,
        state: event.receipt.state,
        outcomes,
        issues,
        capacity,
      };
      const existing = state.chunkSummaries.findIndex((s) => s.operationId === summary.operationId);
      // A selection admits at most four chunks. Status replaces that operation's summary.
      if (existing < 0 && state.chunkSummaries.length === 4) return state;
      const chunkSummaries = [...state.chunkSummaries];
      if (existing < 0) chunkSummaries.push(summary);
      else chunkSummaries[existing] = summary;
      const totals = { outcomes: {}, issues: {}, capacity: {} } as {
        outcomes: Partial<Record<MemoryImportOutcome, number>>;
        issues: Partial<Record<MemoryImportIssue, number>>;
        capacity: Partial<Record<MemoryCapacityDimension, number>>;
      };
      for (const chunk of chunkSummaries) {
        for (const key of Object.keys(chunk.outcomes) as MemoryImportOutcome[])
          totals.outcomes[key] = (totals.outcomes[key] ?? 0) + chunk.outcomes[key]!;
        for (const key of Object.keys(chunk.issues) as MemoryImportIssue[])
          totals.issues[key] = (totals.issues[key] ?? 0) + chunk.issues[key]!;
        for (const key of Object.keys(chunk.capacity) as MemoryCapacityDimension[])
          totals.capacity[key] = (totals.capacity[key] ?? 0) + chunk.capacity[key]!;
      }
      return {
        ...state,
        chunkSummaries,
        totals,
        settledChunks: chunkSummaries.filter((s) => s.state === "completed").length,
        receipt: {
          ...event.receipt,
          items: event.receipt.items.map((item) => ({
            ...item,
            ...(item.capacity === undefined ? {} : { capacity: { ...item.capacity } }),
          })),
        },
        ...(event.receipt.state === "partial"
          ? {
              phase: "recovery" as const,
              message: "Some items may have been applied. Check the import result.",
            }
          : {}),
      };
    }
    case "finish":
      return {
        ...state,
        phase: state.stopped || state.settledChunks !== event.totalChunks ? "partial" : "completed",
      };
  }
}

/** Snapshot selection/scope/project and split without ever persisting selectors. */
export function memoryImportChunks(items: readonly MemoryImportSelection[]) {
  if (items.length === 0 || items.length > 128) throw new Error("Select between 1 and 128 items");
  if (new Set(items.map((item) => item.sourceItemKey)).size !== items.length)
    throw new Error("Select each item once");
  const snapshot = items.map((item) => ({
    ...item,
    scope:
      item.scope.kind === "project"
        ? { ...item.scope, projectKey: { ...item.scope.projectKey } }
        : item.scope.kind === "thread"
          ? {
              ...item.scope,
              thread: { ...item.scope.thread },
              ...(item.scope.projectKey === undefined
                ? {}
                : { projectKey: { ...item.scope.projectKey } }),
            }
          : { ...item.scope },
    ...(item.project === undefined ? {} : { project: { ...item.project } }),
  }));
  return Array.from({ length: Math.ceil(snapshot.length / 32) }, (_, i) =>
    snapshot.slice(i * 32, (i + 1) * 32),
  );
}

export function sameMemoryImportFence(a: MemoryImportFence, b: MemoryImportFence) {
  return (
    a.environmentId === b.environmentId &&
    a.memorySpaceId === b.memorySpaceId &&
    a.session === b.session
  );
}

/** Inject the existing state/memory.importProvider guarded command, never a raw RPC client.
 * canImport must read that command's permissionAtom for this exact environment at execution.
 * A recovery handle is status-only evidence, never authority to apply again.
 */
export function createMemoryImportWorkflow(options: {
  readonly fence: MemoryImportFence;
  readonly recovery: MemoryImportRecoveryStore;
  readonly canImport: (destination: MemoryImportDestination) => boolean;
  readonly request: (
    environmentId: MemoryImportDestination["environmentId"],
    input: MemoryImportProviderInput,
  ) => Promise<MemoryImportProviderResult>;
  readonly operationId: () => MemoryOperationId;
}) {
  let fence = { ...options.fence };
  let generation = 0;
  let activeGeneration: number | null = null;
  const isBusy = () => activeGeneration === generation;
  let state = initialMemoryImportWorkflowState;
  let preview: Preview | null = null;
  let chunks: Array<{ operationId: MemoryOperationId; items: Apply["items"] }> = [];
  const current = (token: number) => token === generation;
  const permitted = () => options.canImport(fence);
  const listeners = new Set<() => void>();
  let notificationQueued = false;
  const notify = () => {
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      for (const listener of Array.from(listeners)) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // This Promise-based client store reports subscriber failures outside workflow control flow.
          // @effect-diagnostics-next-line globalConsole:off
          console.error("Memory import listener failed");
        }
      }
    });
  };
  const setState = (patch: Partial<MemoryImportWorkflowState>) => {
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = freezeSnapshot(next);
    notify();
  };
  const progress = (event: MemoryImportProgressEvent) =>
    setState(reduceMemoryImportProgress(state, event));
  let chunkIndex = 0;
  const canSend = (token: number, destination: MemoryImportFence) =>
    current(token) &&
    !state.stopped &&
    sameMemoryImportFence(destination, fence) &&
    options.canImport(destination);
  const request = (input: MemoryImportProviderInput, destination = { ...fence }) => {
    if (!options.canImport(destination) || !sameMemoryImportFence(destination, fence))
      throw new Error("Memory import is unavailable");
    return options.request(destination.environmentId, input);
  };
  function invalidate(next = fence) {
    fence = { ...next };
    generation++;
    preview = null;
    chunks = [];
    chunkIndex = 0;
    setState(initialMemoryImportWorkflowState);
  }
  async function exclusive<T>(run: (token: number) => Promise<T>) {
    if (isBusy()) throw new Error("Wait for the current import request");
    const token = generation;
    activeGeneration = token;
    try {
      return await run(token);
    } finally {
      if (activeGeneration === token) activeGeneration = null;
    }
  }
  const runChunks = (retry: boolean) =>
    exclusive(async (token) => {
      if (
        state.phase !== (retry ? "save_failed" : "previewed") ||
        preview === null ||
        state.stopped
      )
        throw new Error("Preview before importing");
      const fixedPreview = preview;
      const destination = { ...fence };
      for (; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]!;
        if (!current(token) || state.stopped) break;
        if (!permitted()) {
          setState({ phase: "partial", message: "Memory import is unavailable" });
          break;
        }
        setState({ phase: "saving", message: null });
        try {
          await options.recovery.save(destination, chunk.operationId);
        } catch {
          // A rejected write can have persisted. Only a confirmed empty slot permits retry.
          let handle;
          try {
            handle = await options.recovery.load(destination);
          } catch {
            if (current(token))
              setState({ phase: "recovery", message: "Reconnect and check the import result." });
            return;
          }
          if (!current(token)) return;
          setState(
            handle === null
              ? {
                  phase: "save_failed",
                  message: "Couldn't save import progress. Nothing was imported from this batch.",
                }
              : {
                  phase: "recovery",
                  message: "Check the saved import result before importing more items.",
                },
          );
          return;
        }
        if (!canSend(token, destination)) {
          await options.recovery.clear(destination, chunk.operationId);
          if (current(token)) setState({ phase: "partial" });
          break;
        }
        setState({ phase: "applying" });
        // Deliver the pending notification before admitting this chunk.
        await Promise.resolve();
        if (!canSend(token, destination)) {
          await options.recovery.clear(destination, chunk.operationId);
          if (current(token)) setState({ phase: "partial" });
          return;
        }
        try {
          const result = await request(
            {
              action: "apply",
              memorySpaceId: destination.memorySpaceId,
              sourceId: fixedPreview.sourceId,
              sessionId: fixedPreview.sessionId,
              operationId: chunk.operationId,
              items: chunk.items,
            },
            destination,
          );
          if (!current(token)) return;
          if (
            result.action !== "apply" ||
            result.receipt.operationId !== chunk.operationId ||
            result.receipt.sessionId !== fixedPreview.sessionId ||
            result.receipt.sourceId !== fixedPreview.sourceId
          )
            throw new Error("Unexpected import result");
          // A partial receipt is unresolved: do not discard its recovery ID or admit another chunk.
          if (result.receipt.state === "partial") {
            progress({
              type: "receipt",
              receipt: result.receipt,
            });
            return;
          }
          await options.recovery.clear(destination, chunk.operationId);
          if (!current(token)) return;
          progress({ type: "receipt", receipt: result.receipt });
        } catch {
          if (current(token))
            setState({
              phase: "recovery",
              message: "The result is unknown. Reconnect and check the import result.",
            });
          return;
        }
      }
      if (current(token)) progress({ type: "finish", totalChunks: chunks.length });
    });
  return {
    getState: () => state,
    getSnapshot: () => state,
    /** Notifications coalesce in a microtask; read the latest snapshot, not every phase. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Call for destination/session changes. Selection or scope changes also invalidate preview. */
    invalidate,
    removeDestination: async () => {
      const previous = { ...fence };
      invalidate();
      await options.recovery.clear(previous);
    },
    stop: () => {
      progress({ type: "stop", inFlight: isBusy() });
    },
    discover: (format: MemoryImportFormat) =>
      exclusive(async (token) => {
        preview = null;
        chunks = [];
        setState({
          ...initialMemoryImportWorkflowState,
          phase: "discovering",
          stopped: false,
          settledChunks: 0,
          receipt: null,
          message: null,
        });
        const result = await request({
          action: "discover",
          format,
          memorySpaceId: fence.memorySpaceId,
        });
        if (!current(token)) return;
        if (result.action !== "discover") throw new Error("Unexpected import result");
        setState({ phase: "discovered" });
        return result;
      }),
    preview: (sourceId: MemoryImportSourceId) =>
      exclusive(async (token) => {
        preview = null;
        chunks = [];
        setState({
          ...initialMemoryImportWorkflowState,
          phase: "previewing",
          stopped: false,
          settledChunks: 0,
          receipt: null,
          message: null,
        });
        const result = await request({
          action: "preview",
          sourceId,
          memorySpaceId: fence.memorySpaceId,
        });
        if (!current(token)) return;
        if (result.action !== "preview" || result.sourceId !== sourceId)
          throw new Error("Unexpected import preview");
        preview = { ...result, items: result.items.map((item) => ({ ...item })) };
        setState({ phase: "selecting" });
        return result;
      }),
    /** Confirm once. Any later selection/scope change must invalidate and preview again. */
    select: (items: readonly MemoryImportSelection[]) => {
      if (state.phase === "previewed") {
        invalidate();
        setState({
          phase: "repreview",
          message: "The selection changed. Preview again before importing.",
        });
        return;
      }
      if (isBusy() || state.phase !== "selecting" || preview === null)
        throw new Error("Preview before selecting items");
      const selected = memoryImportChunks(items);
      const fixedPreview = preview;
      if (
        selected
          .flat()
          .some(
            (item) =>
              !fixedPreview.items.some(
                (candidate) =>
                  candidate.sourceItemKey === item.sourceItemKey &&
                  candidate.sourceFingerprint === item.sourceFingerprint &&
                  candidate.issue === undefined,
              ),
          )
      ) {
        preview = null;
        setState({
          phase: "repreview",
          message: "The selection changed. Preview again before importing.",
        });
        return;
      }
      chunks = selected.map((items) => ({ operationId: options.operationId(), items }));
      if (new Set(chunks.map((chunk) => chunk.operationId)).size !== chunks.length) {
        chunks = [];
        throw new Error("Each chunk needs a distinct operation");
      }
      chunkIndex = 0;
      setState({ phase: "previewed" });
    },
    /** One deliberate start runs sequential chunks; recovery never calls this method. */
    apply: () => runChunks(false),
    /** Retry only a confirmed unsent storage failure, retaining the exact chunk and selectors. */
    retry: () => runChunks(true),
    /** Restart/offline recovery issues exactly one status request and never an apply. */
    recover: () =>
      exclusive(async (token) => {
        const destination = { ...fence };
        const handle = await options.recovery.load(destination);
        if (!current(token)) return;
        if (handle === null) {
          setState({
            phase: "repreview",
            message: "Preview again before importing. Previous items may have been applied.",
          });
          return;
        }
        setState({ phase: "checking" });
        await Promise.resolve();
        if (!canSend(token, destination)) {
          if (current(token)) setState({ phase: "recovery" });
          return;
        }
        try {
          const result = await request(
            {
              action: "status",
              memorySpaceId: destination.memorySpaceId,
              operationId: handle.operationId,
            },
            destination,
          );
          if (!current(token)) return;
          if (result.action !== "status" || result.receipt.operationId !== handle.operationId)
            throw new Error("Unexpected import status");
          if (result.receipt.state === "completed")
            await options.recovery.clear(destination, handle.operationId);
          if (!current(token)) return;
          preview = null;
          chunks = [];
          setState({
            ...reduceMemoryImportProgress(state, { type: "receipt", receipt: result.receipt }),
            phase: result.receipt.state === "partial" ? "recovery" : "repreview",
            message: "Review the result and preview again before importing more items.",
          });
        } catch (error) {
          if (!current(token)) return;
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "not_found"
          ) {
            await options.recovery.clear(destination, handle.operationId);
            if (current(token))
              setState({
                phase: "repreview",
                message:
                  "The saved result is unavailable. Previous items may have been applied. Preview again.",
              });
          } else setState({ phase: "recovery", message: "Reconnect and check the import result." });
        }
      }),
  };
}
