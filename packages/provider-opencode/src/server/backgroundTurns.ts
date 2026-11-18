import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import type { MessageId, OrchestrationV2ProviderThread } from "@goat/contracts";
import type { ProviderContinuationRequest } from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { OPENCODE_PROVIDER } from "./adapterProtocol.ts";

const MAX_HELD_EVENTS = 512;
const MAX_HELD_BYTES = 4 * 1024 * 1024;
const NATIVE_ADMISSION_TIMEOUT = "10 seconds";
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type BackgroundOwner = {
  readonly nativeSessionId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly activeTurn: unknown;
  readonly userMessageIds: string[];
  readonly parentSubagent: unknown;
};

interface BackgroundTurn {
  readonly messageId: MessageId;
  readonly events: OpenCodeEvent[];
  readonly promptIds: Set<string>;
  readonly admission: Deferred.Deferred<boolean>;
  settled: Deferred.Deferred<void>;
  bytes: number;
  offered: boolean;
  cancelling: boolean;
}

export function openCodeWorkSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.updated":
    case "message.part.delta":
    case "todo.updated":
    case "session.compacted":
    case "session.status":
    case "session.idle":
    case "session.error":
    case "permission.asked":
    case "question.asked":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

export function openCodeBufferedContinuation(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "provider";
}

export function makeOpenCodeBackgroundTurns<
  State extends BackgroundOwner,
  RootError,
  CleanupError,
>(options: {
  readonly ownerOf: (nativeSessionId: string) => State | undefined;
  readonly isClosed: () => boolean;
  readonly makeMessageId: (nativeSessionId: string, promptId: string) => MessageId;
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly abortRoot: (state: State) => Effect.Effect<unknown, RootError>;
  readonly cleanup: (
    state: State,
    rootAbort: Effect.Effect<unknown, RootError>,
  ) => Effect.Effect<void, CleanupError>;
  readonly breakSession: (detail: string) => Effect.Effect<void>;
}) {
  const events = Semaphore.makeUnsafe(1);
  const lifecycle = Semaphore.makeUnsafe(1);
  const held = new Map<State, BackgroundTurn>();

  const discard = Effect.fnUntraced(function* (state: State, wake: BackgroundTurn) {
    if (held.get(state) !== wake) return;
    held.delete(state);
    for (const id of wake.promptIds) {
      if (!state.userMessageIds.includes(id)) state.userMessageIds.push(id);
    }
    wake.events.length = 0;
    yield* Deferred.succeed(wake.admission, false);
    yield* Deferred.succeed(wake.settled, undefined);
  });

  const cancel = Effect.fn("OpenCode.cancelBackgroundTurn")(
    function* (state: State, wake: BackgroundTurn) {
      if (options.isClosed() || held.get(state) !== wake) return;
      wake.cancelling = true;
      const admitted = yield* Deferred.await(wake.admission).pipe(
        Effect.timeoutOption(NATIVE_ADMISSION_TIMEOUT),
      );
      let rootAbortFailed = false;
      const rootAbort = Option.getOrElse(admitted, () => true)
        ? options.abortRoot(state).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                rootAbortFailed = true;
              }),
            ),
          )
        : Effect.void;
      yield* options.cleanup(state, rootAbort).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            if (rootAbortFailed && !(yield* Deferred.isDone(wake.settled))) {
              yield* options.breakSession(
                "OpenCode background cancellation failed before native idle. Reconnect the provider session.",
              );
            }
          }),
        ),
      );
    },
    (effect, state, wake) => effect.pipe(Effect.ensuring(discard(state, wake))),
  );

  const offer = (
    state: State,
    wake: BackgroundTurn,
    threadId: NonNullable<OrchestrationV2ProviderThread["appThreadId"]>,
  ) => {
    const cancelIfCurrent = () =>
      lifecycle.withPermit(cancel(state, wake)).pipe(Effect.ignore({ log: true }));
    return options.offer({
      threadId,
      providerThreadId: state.providerThread.id,
      driver: OPENCODE_PROVIDER,
      detail: null,
      delivery: "adapter_buffered",
      messageId: wake.messageId,
      dispatchIfCurrent: (dispatch) =>
        events.withPermit(
          Effect.suspend(() =>
            held.get(state) === wake && !wake.cancelling && !options.isClosed()
              ? Effect.asSome(dispatch)
              : Effect.succeedNone,
          ),
        ),
      clearIfCurrent: cancelIfCurrent,
      onRunEndedWithoutStarting: cancelIfCurrent,
    });
  };

  // Called under the event permit. Registered child sessions keep their own work and requests.
  const hold = Effect.fnUntraced(function* (event: OpenCodeEvent) {
    const sessionId = openCodeWorkSessionId(event);
    if (sessionId === undefined || options.isClosed()) return false;
    const state = options.ownerOf(sessionId);
    if (state === undefined) return false;
    const isRoot = state.nativeSessionId === sessionId;
    const threadId = state.providerThread.appThreadId;
    const promptId =
      isRoot && event.type === "message.updated" && event.properties.info.role === "user"
        ? event.properties.info.id
        : undefined;
    const status = isRoot && event.type === "session.status" ? event.properties.status.type : null;
    const busy = status === "busy" || status === "retry";
    const ended =
      isRoot &&
      (status === "idle" ||
        event.type === "session.idle" ||
        (event.type === "session.error" &&
          event.properties.error?.name !== "ContextOverflowError"));

    let wake = held.get(state);
    if (wake === undefined) {
      if (
        promptId === undefined ||
        threadId === null ||
        state.activeTurn !== null ||
        state.parentSubagent !== null ||
        state.userMessageIds.includes(promptId)
      ) {
        return false;
      }
      wake = {
        messageId: options.makeMessageId(sessionId, promptId),
        events: [],
        promptIds: new Set(),
        admission: Deferred.makeUnsafe(),
        settled: Deferred.makeUnsafe(),
        bytes: 0,
        offered: false,
        cancelling: false,
      };
      // Deduplicate the initial native receipt before a continuation takes ownership.
      state.userMessageIds.push(promptId);
      held.set(state, wake);
    } else if (!isRoot && (wake.cancelling || !wake.offered)) {
      return false;
    }

    const newPrompt = promptId !== undefined && !wake.promptIds.has(promptId);
    if ((busy || newPrompt) && (yield* Deferred.isDone(wake.settled))) {
      wake.settled = Deferred.makeUnsafe();
    }
    if (ended) {
      yield* Deferred.succeed(wake.settled, undefined);
      if (!wake.offered && !wake.cancelling) {
        yield* discard(state, wake);
        return false;
      }
      yield* Deferred.succeed(wake.admission, false);
    }
    if (wake.cancelling) {
      if (busy) yield* Deferred.succeed(wake.admission, true);
      return true;
    }

    const bytes = Buffer.byteLength(encodeEvent(event));
    if (wake.events.length >= MAX_HELD_EVENTS || wake.bytes + bytes > MAX_HELD_BYTES) {
      yield* discard(state, wake);
      yield* options.breakSession(
        "OpenCode's buffered background output exceeded the session limit. Reconnect the provider session.",
      );
      yield* options.cleanup(state, options.abortRoot(state)).pipe(Effect.ignore({ log: true }));
      return true;
    }
    wake.events.push(event);
    wake.bytes += bytes;
    if (promptId !== undefined) wake.promptIds.add(promptId);
    if (!wake.offered && busy && threadId !== null) {
      wake.offered = true;
      yield* Deferred.succeed(wake.admission, true);
      yield* offer(state, wake, threadId);
    }
    return true;
  });

  const awaitAdmission = Effect.fn("OpenCode.awaitBackgroundAdmission")(function* (state: State) {
    const candidate = held.get(state);
    if (candidate === undefined || candidate.offered) return;
    const reply = yield* Deferred.await(candidate.admission).pipe(
      Effect.timeoutOption(NATIVE_ADMISSION_TIMEOUT),
    );
    if (Option.isNone(reply)) yield* discard(state, candidate);
  });

  const take = (state: State, messageId: MessageId | null) => {
    const wake = held.get(state);
    if (wake === undefined || (messageId !== null && wake.messageId !== messageId)) return null;
    held.delete(state);
    return wake;
  };

  return {
    serializeEvents: events.withPermit,
    serializeLifecycle: lifecycle.withPermit,
    hasOffered: () => Array.from(held.values()).some((wake) => wake.offered && !wake.cancelling),
    matches: (state: State, messageId: MessageId) => held.get(state)?.messageId === messageId,
    hold,
    take,
    awaitAdmission,
    close: () => Effect.forEach(held, ([state, wake]) => discard(state, wake), { discard: true }),
    stop: Effect.fn("OpenCode.stopBackgroundTurn")(function* (state: State) {
      const wake = held.get(state);
      yield* wake === undefined ? options.cleanup(state, Effect.void) : cancel(state, wake);
    }),
    stopIfCurrent: (state: State, messageId: MessageId) =>
      lifecycle.withPermit(
        Effect.suspend(() => {
          const wake = held.get(state);
          return wake?.messageId === messageId
            ? cancel(state, wake).pipe(Effect.ignore({ log: true }))
            : Effect.void;
        }),
      ),
  };
}
