import {
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateResult,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { isRpcClientError } from "../rpc/client.ts";
import { IDLE_SERVER_UPDATE_STATE, type ServerUpdateState } from "./server.ts";

export class ServerUpdateResumeTimeoutError extends Schema.TaggedError<ServerUpdateResumeTimeoutError>()(
  "ServerUpdateResumeTimeoutError",
  {
    environmentId: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Could not confirm that the server resumed on GOAT ${this.targetVersion}. Reconnect to check the update outcome.`;
  }
}

export class ServerUpdateProgressIncompleteError extends Schema.TaggedError<ServerUpdateProgressIncompleteError>()(
  "ServerUpdateProgressIncompleteError",
  {
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The GOAT ${this.targetVersion} update ended before the server accepted the restart.`;
  }
}

export class ServerUpdateTerminalError extends Schema.TaggedError<ServerUpdateTerminalError>()(
  "ServerUpdateTerminalError",
  {
    targetVersion: Schema.String,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `The GOAT ${this.targetVersion} update ${this.status}.`;
  }
}

// Covers the service launcher's 30-minute trial deadline (PREPARED_TIMEOUT_MS)
// and a final restart of the previous version when the trial rolls back.
export const SERVER_UPDATE_RESUME_TIMEOUT = Duration.minutes(32);

export function matchesServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return result.updateId === undefined
    ? event.payload.environment.serverVersion === result.targetVersion
    : event.payload.updateOutcome?.id === result.updateId;
}

export function matchesServerUpdateResumeEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return (
    (result.method === "desktop-app" && result.desktopUpdateToken !== undefined) ||
    matchesServerUpdateReadyEvent(result, event)
  );
}

export function validateServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): Effect.Effect<void, ServerUpdateTerminalError> {
  if (result.updateId === undefined) return Effect.void;
  const outcome = event.payload.updateOutcome;
  if (
    outcome?.id === result.updateId &&
    outcome.status === "committed" &&
    outcome.targetVersion === result.targetVersion &&
    event.payload.environment.serverVersion === result.targetVersion
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ServerUpdateTerminalError({
      targetVersion: result.targetVersion,
      status: outcome?.status ?? "failed",
      reason:
        outcome?.reason ??
        "The service launcher resumed without committing the requested server version.",
    }),
  );
}

/**
 * The sleep before each nudge is the pacer: a connection that fails instantly
 * re-enters backoff immediately and would otherwise spin a tight retry loop.
 *
 * Callers fork this as a child of the update command so it is interrupted as
 * soon as the update settles, whether it succeeds, fails, or times out.
 */
export function nudgeReconnectDuringUpdateRestart(input: {
  readonly stateChanges: Stream.Stream<
    {
      readonly phase: string;
      readonly lastFailure?: { readonly reason: string } | null;
    },
    unknown
  >;
  readonly retryNow: Effect.Effect<void>;
  readonly interval?: Duration.Duration;
}): Effect.Effect<void> {
  return input.stateChanges.pipe(
    Stream.filter(
      (state) =>
        state.phase === "backoff" ||
        (state.phase === "blocked" && state.lastFailure?.reason === "authentication"),
    ),
    Stream.runForEach(() =>
      Effect.sleep(input.interval ?? Duration.seconds(1)).pipe(Effect.andThen(input.retryNow)),
    ),
    Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
    Effect.ignore,
  );
}

export function waitForNextEnvironmentReconnect<E>(
  stateChanges: Stream.Stream<{ readonly phase: string }, E>,
): Effect.Effect<void, E> {
  return stateChanges.pipe(
    Stream.dropWhile((state) => state.phase === "connected"),
    Stream.filter((state) => state.phase === "connected"),
    Stream.runHead,
    Effect.asVoid,
  );
}

export const runDesktopCommitWithReconnectObserver = Effect.fn(
  "runDesktopCommitWithReconnectObserver",
)(function* <EState, ECommit>(
  stateChanges: Stream.Stream<{ readonly phase: string }, EState>,
  commit: Effect.Effect<void, ECommit>,
) {
  const armed = yield* Deferred.make<void>();
  const reconnected = yield* Deferred.make<void>();
  const observer = yield* stateChanges.pipe(
    Stream.tap(() => Deferred.succeed(armed, undefined)),
    waitForNextEnvironmentReconnect,
    Effect.andThen(Deferred.succeed(reconnected, undefined)),
    Effect.forkChild,
  );
  yield* Deferred.await(armed);
  const commitExit = yield* commit.pipe(Effect.exit);
  if (Exit.isSuccess(commitExit)) {
    yield* Fiber.interrupt(observer);
    return;
  }
  if (!isLegacyUpdateHandoffLoss(commitExit.cause)) {
    yield* Fiber.interrupt(observer);
    return yield* Effect.failCause(commitExit.cause);
  }
  yield* Deferred.await(reconnected).pipe(Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT));
  return yield* Effect.failCause(commitExit.cause);
});

export const waitForDesktopUpdateTarget = Effect.fn("waitForDesktopUpdateTarget")(function* <
  EReady,
  ECommit,
>(
  targetVersion: string,
  nextReady: Effect.Effect<ServerLifecycleStreamReadyEvent, EReady>,
  retryCommit: Effect.Effect<void, ECommit>,
  maxCommitAttempts = 3,
): Effect.fn.Return<ServerLifecycleStreamReadyEvent, EReady | ECommit | ServerUpdateTerminalError> {
  for (let attempt = 1; attempt <= maxCommitAttempts; attempt += 1) {
    const ready = yield* nextReady;
    if (ready.payload.environment.serverVersion === targetVersion) return ready;
    if (attempt === maxCommitAttempts) break;
    const retryExit = yield* retryCommit.pipe(Effect.exit);
    if (Exit.isSuccess(retryExit)) break;
    if (!isLegacyUpdateHandoffLoss(retryExit.cause)) {
      return yield* Effect.failCause(retryExit.cause);
    }
  }
  return yield* new ServerUpdateTerminalError({
    targetVersion,
    status: "failed",
    reason: "The desktop app resumed without installing the prepared update.",
  });
});

export function serverUpdateStateForProgressEvent(
  fromVersion: string,
  targetVersion: string,
  event: ServerSelfUpdateProgressEvent,
): Extract<ServerUpdateState, { status: "running" }> {
  return {
    status: "running",
    stage:
      event.type !== "complete"
        ? event.stage
        : event.result.method === "desktop-app" && event.result.desktopUpdateToken !== undefined
          ? "installing"
          : "resuming",
    fromVersion,
    targetVersion,
  };
}

export function serverUpdateStateForServerVersion(
  state: ServerUpdateState,
  serverVersion: string | null,
): ServerUpdateState {
  return state.status === "idle" ||
    state.status === "running" ||
    serverVersion === null ||
    state.fromVersion === serverVersion
    ? state
    : IDLE_SERVER_UPDATE_STATE;
}

export function serverUpdateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function isRpcSocketError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export function isLegacyUpdateHandoffLoss(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) {
    return true;
  }
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => Cause.isFailReason(reason) && isRpcSocketError(reason.error))
  );
}

export function resolveServerUpdateProgressResult<E>(
  targetVersion: string,
  terminal: Option.Option<ServerSelfUpdateResult>,
  streamExit: Exit.Exit<void, E>,
  accepted?: ServerSelfUpdateResult,
): Effect.Effect<ServerSelfUpdateResult, E | ServerUpdateProgressIncompleteError> {
  if (
    Option.isSome(terminal) &&
    (Exit.isSuccess(streamExit) || isLegacyUpdateHandoffLoss(streamExit.cause))
  ) {
    return Effect.succeed(terminal.value);
  }
  if (Exit.isFailure(streamExit)) {
    if (accepted !== undefined && isLegacyUpdateHandoffLoss(streamExit.cause)) {
      return Effect.succeed(accepted);
    }
    return Effect.failCause(streamExit.cause);
  }
  return Effect.fail(new ServerUpdateProgressIncompleteError({ targetVersion }));
}
