// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - This module owns one exact child process and its watchdog.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { BoundedLines } from "@goat/shared/boundedLines";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { selfInvocationArgs, type SelfInvocation } from "@goat/shared/nodeRuntime";
import {
  ScreenHostCall,
  type ScreenRunBoot,
  type ScreenRunLimits,
  type ScreenRunResult,
  ScreenRunError,
  ScreenGuestError,
  ScreenEffectReceipt,
} from "@goat/contracts";
import { ScreenHostBridge, type ScreenHostContext } from "./ScreenHostBridge.ts";

const isScreenGuestError = Schema.is(ScreenGuestError);
const isScreenRunError = Schema.is(ScreenRunError);

const decodeUnknownScreenHostCall = Schema.decodeUnknownSync(ScreenHostCall);

export interface ScreenRunIdentity {
  readonly runId: string;
  readonly turnId: string;
  readonly context: ScreenHostContext;
}

const SupervisorCode = Schema.Literals([
  "deadline",
  "resource_exhausted",
  "runtime_unavailable",
  "stopped",
  "invalid_argument",
  "live_children_limit",
  "pending_limit",
  "output_limit",
  "wall_limit",
  "unknown_outcome",
]);
export class ScreenSupervisorFailure extends Schema.TaggedError<ScreenSupervisorFailure>()(
  "ScreenSupervisorFailure",
  {
    code: SupervisorCode,
    effectStarted: Schema.optionalKey(Schema.Boolean),
    receipts: Schema.optionalKey(Schema.Array(ScreenEffectReceipt)),
  },
) {}
const isScreenSupervisorFailure = Schema.is(ScreenSupervisorFailure);
const failure = (
  code: typeof SupervisorCode.Type,
  options: {
    effectStarted?: boolean;
    receipts?: readonly ScreenEffectReceipt[];
  } = {},
) =>
  new ScreenSupervisorFailure({
    code,
    ...(options.effectStarted === undefined ? {} : { effectStarted: options.effectStarted }),
    ...(options.receipts === undefined ? {} : { receipts: [...options.receipts] }),
  });

interface ActiveCell {
  readonly cellId: string;
  readonly runId: string;
  readonly turnId: string;
}

/**
 * One booted child. A thread keeps its own across turns, so its values and the runtime's start
 * cost both carry over; a spare has no thread yet and is handed to the next thread that needs one.
 */
interface Session {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly lines: BoundedLines;
  readonly turnWasmBytes: number;
  thread: string | undefined;
  active: ActiveCell | undefined;
  abortActive: ((code: typeof SupervisorCode.Type) => void) | undefined;
  closed: boolean;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const MAX_FRAME_BYTES = 256 * 1024;
// A child holds tens of megabytes; one left alone this long is ended and its thread starts fresh.
const IDLE_CHILD_MS = 10 * 60 * 1000;
// The child ends a cell at the same deadline; this only catches a child that stopped answering.
const BACKSTOP_GRACE_MS = 2_000;
const ChildResultFrame = Schema.Struct({
  t: Schema.Literal("result"),
  cellId: Schema.String,
  status: Schema.Literals(["completed", "failed", "stopped", "deadline", "resource_exhausted"]),
  value: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Union([ScreenRunError, ScreenGuestError])),
  console: Schema.Array(Schema.String),
  truncated: Schema.Array(Schema.String),
  unawaitedCallIds: Schema.optionalKey(Schema.Array(Schema.Int)),
});
const decodeChildResult = Schema.decodeUnknownSync(ChildResultFrame);
const UNREAD_AVAILABILITY = [
  { kind: "app" as const, available: false, reason: "no_lease" as const },
  { kind: "tab" as const, available: false, reason: "no_host" as const },
];
export const screenChildInvocation = (invocation: SelfInvocation) => ({
  command: invocation.command,
  args: selfInvocationArgs(invocation, ["__screen-run-child"]),
});

export function createScreenRunSupervisor(deps: {
  readonly asset: { readonly path: string; readonly sha256: string };
  readonly limits: ScreenRunLimits;
  readonly hostBridge: ScreenHostBridge;
  readonly invocation: SelfInvocation;
  readonly runCallback: <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>;
  readonly scheduleDeadline?: (run: () => void, ms: number) => () => void;
}) {
  const sessions = new Map<string, Session>();
  let spare: Session | undefined;
  let disposed = false;
  /** Threads whose child ended while it held their values; their next cell is told. */
  const lost = new Set<string>();
  const liveChildren = () => sessions.size + (spare === undefined ? 0 : 1);
  const armIdle = (session: Session) => {
    clearTimeout(session.idleTimer);
    session.lastUsed = Date.now();
    session.idleTimer = setTimeout(() => {
      if (!session.active) close(session);
    }, IDLE_CHILD_MS);
    session.idleTimer.unref?.();
  };
  const spawnSession = (turnWasmBytes: number) => {
    const { command, args } = screenChildInvocation(deps.invocation);
    const isElectron =
      process.versions.electron !== undefined ||
      NodePath.basename(command).toLowerCase().includes("electron");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    if (isElectron) env.ELECTRON_RUN_AS_NODE = "1";
    const child = NodeChildProcess.spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    const session: Session = {
      child,
      lines: new BoundedLines(child.stdout, MAX_FRAME_BYTES),
      turnWasmBytes,
      thread: undefined,
      closed: false,
      active: undefined,
      abortActive: undefined,
      lastUsed: Date.now(),
      idleTimer: undefined,
    };
    session.lines.on("limit", () => {
      session.abortActive?.("output_limit");
      close(session);
    });
    child.stderr.resume();
    const onProcessEnd = () => {
      session.abortActive?.("runtime_unavailable");
      close(session);
    };
    child.once("exit", onProcessEnd);
    child.once("error", onProcessEnd);
    const boot: ScreenRunBoot = {
      t: "boot",
      limits: { ...deps.limits, turnWasmBytes },
      wasmPath: deps.asset.path,
      wasmSha256: deps.asset.sha256,
    };
    child.stdin.write(`${JSON.stringify(boot)}\n`);
    armIdle(session);
    return session;
  };
  const close = (session: Session) => {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.idleTimer);
    if (spare === session) spare = undefined;
    if (session.thread !== undefined && sessions.get(session.thread) === session) {
      sessions.delete(session.thread);
      lost.add(session.thread);
    }
    session.child.stdin.end();
    // Only the captured ChildProcess may be killed; no PID lookup or pattern matching.
    if (session.child.exitCode === null) session.child.kill("SIGKILL");
    session.lines.close();
  };
  /** Makes room under the child cap: the spare goes first, then the longest idle thread's child. */
  const makeRoom = () => {
    while (liveChildren() >= deps.limits.activeChildren) {
      if (spare !== undefined) {
        close(spare);
        continue;
      }
      let oldest: Session | undefined;
      for (const session of sessions.values())
        if (!session.active && (oldest === undefined || session.lastUsed < oldest.lastUsed))
          oldest = session;
      if (oldest === undefined) throw failure("live_children_limit");
      close(oldest);
    }
  };
  /** Boots the next thread's child ahead of its first cell, when the cap leaves room. */
  const prewarm = () => {
    if (disposed || spare !== undefined || liveChildren() >= deps.limits.activeChildren) return;
    try {
      spare = spawnSession(deps.limits.turnWasmBytes);
    } catch {
      spare = undefined;
    }
  };
  const sessionFor = (thread: string, turnWasmBytes: number) => {
    if (disposed) throw failure("runtime_unavailable");
    const existing = sessions.get(thread);
    if (existing !== undefined) return existing;
    let session: Session;
    if (spare !== undefined && !spare.closed && spare.turnWasmBytes === turnWasmBytes) {
      session = spare;
      spare = undefined;
    } else {
      makeRoom();
      session = spawnSession(turnWasmBytes);
    }
    session.thread = thread;
    sessions.set(thread, session);
    return session;
  };
  const sessionOfCell = (runId: string, turnId: string, cellId?: string) => {
    for (const session of sessions.values())
      if (
        session.active?.runId === runId &&
        session.active.turnId === turnId &&
        (cellId === undefined || session.active.cellId === cellId)
      )
        return session;
    return undefined;
  };
  const abortCellNow = (runId: string, turnId: string, cellId: string) => {
    sessionOfCell(runId, turnId, cellId)?.abortActive?.("stopped");
  };
  return {
    runCell: Effect.fn("ScreenRunSupervisor.runCell")(function* (
      identity: ScreenRunIdentity,
      source: string,
      resetValues: boolean,
    ) {
      const thread = identity.context.threadId;
      const session = yield* Effect.try({
        try: () => sessionFor(thread, identity.context.limits.turnWasmBytes),
        catch: (cause) =>
          isScreenSupervisorFailure(cause) ? cause : failure("runtime_unavailable"),
      });
      if (session.closed || session.active) return yield* failure("pending_limit");
      const cellId = identity.context.cellId;
      session.active = { cellId, runId: identity.runId, turnId: identity.turnId };
      clearTimeout(session.idleTimer);
      // The next thread's child boots while this one works, off this cell's path.
      setImmediate(prewarm);
      return yield* Effect.tryPromise({
        try: (signal) =>
          new Promise<ScreenRunResult>((resolve, reject) => {
            let settled = false;
            // Set once the child's result arrives: a later Stop or exit finishes the cell with that
            // result, because the bridge's journal is already taken.
            let finishAfterResult: (() => void) | undefined;
            const hostErrors = new Map<number, ScreenRunError>();
            const callAbort = new AbortController();
            const cleanup = () => {
              cancelDeadline();
              signal.removeEventListener("abort", onAbort);
              session.lines.off("line", onLine);
              session.active = undefined;
              session.abortActive = undefined;
              if (!session.closed) armIdle(session);
            };
            const failRun = (code: typeof SupervisorCode.Type) => {
              if (settled) return;
              if (finishAfterResult) return finishAfterResult();
              settled = true;
              cleanup();
              deps.hostBridge.cutCellNow(identity.runId, identity.turnId, cellId);
              const { journal, effectsStarted } = deps.hostBridge.takeCellImagesNow(
                identity.runId,
                identity.turnId,
                cellId,
              );
              const receipts = journal.slice(-16).map(({ receipt }) =>
                receipt.journalState === "settled"
                  ? receipt
                  : receipt.dispatched
                    ? {
                        ...receipt,
                        journalState: "unknown" as const,
                        category: "unknown_outcome" as const,
                      }
                    : {
                        ...receipt,
                        journalState: "settled" as const,
                        category: "refused" as const,
                      },
              );
              const effectStarted =
                effectsStarted > 0 || receipts.some((receipt) => receipt.dispatched);
              callAbort.abort();
              close(session);
              reject(
                failure(effectStarted ? "unknown_outcome" : code, { effectStarted, receipts }),
              );
            };
            const onAbort = () => failRun("stopped");
            const onLine = (line: string) => {
              if (finishAfterResult || settled) return;
              if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return failRun("output_limit");
              let frame: unknown;
              try {
                frame = JSON.parse(line);
              } catch {
                return failRun("runtime_unavailable");
              }
              if (typeof frame !== "object" || frame === null || !("t" in frame))
                return failRun("runtime_unavailable");
              if (frame.t === "call") {
                let call;
                try {
                  call = decodeUnknownScreenHostCall(frame);
                } catch {
                  return failRun("runtime_unavailable");
                }
                void deps
                  .runCallback(deps.hostBridge.handle(call, identity.context), callAbort.signal)
                  .then(
                    (reply) => {
                      if (reply?.outcome === "error" && reply.error)
                        hostErrors.set(call.callId, reply.error);
                      if (reply && !session.closed && session.active?.cellId === cellId)
                        session.child.stdin.write(`${JSON.stringify(reply)}\n`);
                    },
                    // Aborting unawaited calls after a result is ours; it is not a runtime failure.
                    () => {
                      if (!callAbort.signal.aborted) failRun("runtime_unavailable");
                    },
                  );
                return;
              }
              let result;
              try {
                result = decodeChildResult(frame);
              } catch {
                return failRun("runtime_unavailable");
              }
              if (result.cellId !== cellId) return failRun("runtime_unavailable");
              // The child finished inside its wall limit; only collection remains.
              cancelDeadline();
              session.lines.off("line", onLine);
              const error = isScreenRunError(result.error)
                ? result.error.callId !== undefined &&
                  hostErrors.get(result.error.callId)?.code === result.error.code
                  ? hostErrors.get(result.error.callId)
                  : undefined
                : isScreenGuestError(result.error)
                  ? result.error
                  : undefined;
              const finish = (
                taken: ReturnType<ScreenHostBridge["takeCellImagesNow"]>,
                availability: ScreenRunResult["availability"],
              ) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                  runId: identity.runId,
                  turnId: identity.turnId,
                  cellId,
                  status: result.status,
                  ...(error === undefined ? {} : { error }),
                  ...(result.value === undefined ? {} : { value: result.value }),
                  console: Array.isArray(result.console) ? result.console : [],
                  truncated: [
                    ...(Array.isArray(result.truncated) ? result.truncated : []),
                    ...taken.truncated,
                  ],
                  journal: taken.journal,
                  imageMetadata: taken.imageMetadata,
                  images: taken.images,
                  availability,
                });
              };
              // Collected in this callback, so no queued call can dispatch between the result
              // and its journal; unawaited calls are stopped only after that.
              if (result.status === "failed")
                deps.hostBridge.cutCellNow(identity.runId, identity.turnId, cellId, "unawaited");
              if (result.unawaitedCallIds?.length)
                deps.hostBridge.markUnawaitedNow(
                  identity.runId,
                  identity.turnId,
                  cellId,
                  result.unawaitedCallIds,
                );
              const collected = deps.hostBridge.takeCellImagesNow(
                identity.runId,
                identity.turnId,
                cellId,
              );
              // The child that sent this result stays until it exits: its exit handler closes it.
              finishAfterResult = () => {
                if (settled) return;
                callAbort.abort();
                finish(collected, UNREAD_AVAILABILITY);
              };
              if (result.unawaitedCallIds?.length) callAbort.abort();
              void deps
                .runCallback(
                  deps.hostBridge
                    .availability(identity.context)
                    .pipe(Effect.timeoutOption("1 second")),
                )
                .then(
                  (available) =>
                    finish(
                      collected,
                      Option.getOrElse(available, () => UNREAD_AVAILABILITY),
                    ),
                  // An unread surface does not undo the result or the live child.
                  () => finish(collected, UNREAD_AVAILABILITY),
                );
            };
            const deadlineMillis = Date.now() + identity.context.limits.cellWallMs;
            const cancelDeadline = deps.scheduleDeadline
              ? deps.scheduleDeadline(
                  () => failRun("wall_limit"),
                  identity.context.limits.cellWallMs + BACKSTOP_GRACE_MS,
                )
              : (() => {
                  const timer = setTimeout(
                    () => failRun("wall_limit"),
                    identity.context.limits.cellWallMs + BACKSTOP_GRACE_MS,
                  );
                  return () => clearTimeout(timer);
                })();
            session.abortActive = failRun;
            signal.addEventListener("abort", onAbort, { once: true });
            session.lines.on("line", onLine);
            if (signal.aborted) return onAbort();
            session.child.stdin.write(
              `${JSON.stringify({ t: "cell", runId: identity.runId, turnId: identity.turnId, cellId, source, resetValues, limits: identity.context.limits, deadlineMillis })}\n`,
            );
          }),
        catch: (cause) =>
          isScreenSupervisorFailure(cause) ? cause : failure("runtime_unavailable"),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            deps.hostBridge.discardCellNow(identity.runId, identity.turnId, cellId);
            close(session);
          }),
        ),
      );
    }),
    cutCell: Effect.fn("ScreenRunSupervisor.cutCell")(function* (
      runId: string,
      turnId: string,
      cellId: string,
      reason: string,
    ) {
      yield* deps.hostBridge.cutCell(runId, turnId, cellId, reason);
      abortCellNow(runId, turnId, cellId);
    }),
    /** Ends the cell before the child can turn a cut reply it caught into a completed result. */
    cutCellNow: abortCellNow,
    /**
     * Ends the turn's running cell, and with it the child that ran it unless the cell already
     * returned. A child with no cell running stays with its thread, values included.
     */
    finishTurn: Effect.fn("ScreenRunSupervisor.finishTurn")(function* (
      runId: string,
      turnId: string,
      reason: string,
    ) {
      const session = sessionOfCell(runId, turnId);
      if (!session?.active) return;
      yield* deps.hostBridge.cutCell(runId, turnId, session.active.cellId, reason);
      session.abortActive?.("stopped");
    }),
    /** Ends a thread's idle child, such as one booted with more WASM memory than a cell allows. */
    closeThread: (thread: string) => {
      const session = sessions.get(thread);
      if (session !== undefined && !session.active) close(session);
    },
    /** Whether the thread's values went with a child that ended since its last cell; asks once. */
    consumeLost: (thread: string) => lost.delete(thread),
    prewarm,
    /** Ends every child, the spare included, when the service that owns them closes. */
    dispose: () => {
      disposed = true;
      if (spare !== undefined) close(spare);
      for (const session of sessions.values()) close(session);
      lost.clear();
    },
    /** Children a thread holds; a spare waiting for its thread is not counted. */
    activeCount: () => sessions.size,
    threadWasmBytes: (thread: string) => sessions.get(thread)?.turnWasmBytes,
  };
}
export type ScreenRunSupervisor = ReturnType<typeof createScreenRunSupervisor>;
