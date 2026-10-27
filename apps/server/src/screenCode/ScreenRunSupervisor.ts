// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - This module owns one exact child process and its watchdog.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
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

interface Session {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly lines: NodeReadline.Interface;
  readonly key: string;
  readonly runId: string;
  readonly turnId: string;
  readonly turnWasmBytes: number;
  active: string | undefined;
  abortActive: ((code: typeof SupervisorCode.Type) => void) | undefined;
  closed: boolean;
}

const key = (runId: string, turnId: string) => `${runId}\u0000${turnId}`;
const MAX_FRAME_BYTES = 256 * 1024;
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
  const spawnSession = (runId: string, turnId: string, turnWasmBytes: number) => {
    if (sessions.size >= deps.limits.activeChildren) throw failure("live_children_limit");
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
      lines: NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
      key: key(runId, turnId),
      runId,
      turnId,
      turnWasmBytes,
      closed: false,
      active: undefined,
      abortActive: undefined,
    };
    child.stderr.resume();
    sessions.set(session.key, session);
    const onProcessEnd = () => {
      session.abortActive?.("runtime_unavailable");
      close(session);
    };
    child.once("exit", onProcessEnd);
    child.once("error", onProcessEnd);
    const boot: ScreenRunBoot = {
      t: "boot",
      runId,
      turnId,
      limits: { ...deps.limits, turnWasmBytes },
      wasmPath: deps.asset.path,
      wasmSha256: deps.asset.sha256,
    };
    child.stdin.write(`${JSON.stringify(boot)}\n`);
    return session;
  };
  const close = (session: Session) => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.key);
    session.child.stdin.end();
    // Only the captured ChildProcess may be killed; no PID lookup or pattern matching.
    if (session.child.exitCode === null) session.child.kill("SIGKILL");
    session.lines.close();
  };
  return {
    runCell: Effect.fn("ScreenRunSupervisor.runCell")(function* (
      identity: ScreenRunIdentity,
      source: string,
      resetValues: boolean,
    ) {
      const id = key(identity.runId, identity.turnId);
      const session = yield* Effect.try({
        try: () =>
          sessions.get(id) ??
          spawnSession(identity.runId, identity.turnId, identity.context.limits.turnWasmBytes),
        catch: (cause) =>
          isScreenSupervisorFailure(cause) ? cause : failure("runtime_unavailable"),
      });
      if (session.closed || session.active) return yield* failure("pending_limit");
      const cellId = identity.context.cellId;
      session.active = cellId;
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
                      if (reply && !session.closed && session.active === cellId)
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
              `${JSON.stringify({ t: "cell", cellId, source, resetValues, limits: identity.context.limits, deadlineMillis })}\n`,
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
      const session = sessions.get(key(runId, turnId));
      if (session?.active === cellId) session.abortActive?.("stopped");
    }),
    finishTurn: Effect.fn("ScreenRunSupervisor.finishTurn")(function* (
      runId: string,
      turnId: string,
      reason: string,
    ) {
      const session = sessions.get(key(runId, turnId));
      if (!session) return;
      if (session.active) {
        yield* deps.hostBridge.cutCell(runId, turnId, session.active, reason);
        session.abortActive?.("stopped");
      }
      // A cell that already returned its result keeps the child through a per-cell Stop; the turn
      // ending still ends it.
      close(session);
    }),
    activeCount: () => sessions.size,
    turnWasmBytes: (runId: string, turnId: string) =>
      sessions.get(key(runId, turnId))?.turnWasmBytes,
  };
}
export type ScreenRunSupervisor = ReturnType<typeof createScreenRunSupervisor>;
