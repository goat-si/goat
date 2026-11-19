import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  SPEECH_STREAM_WS_METHODS,
  authScopeRequiredResponse,
  type EnvironmentId,
  type SpeechStreamEvent,
  type SpeechStreamFeed,
} from "@goat/contracts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  requestInSession,
  runStreamInSession,
  type RpcSession,
} from "@goat/client-runtime/rpc";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  withEnvironmentRpcGuard,
} from "@goat/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";
import { LIVE_SPEECH_CANCEL_WAIT_MS, type LiveSpeechTransport } from "../speech/liveSpeechSession";
import { appAtomRegistry } from "./atomRegistry";

type Pinned<T> = T & {
  readonly session: RpcSession;
  readonly signal?: AbortSignal;
  readonly canSend: () => boolean;
};

function abortable<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
  environmentId: EnvironmentId,
) {
  if (!signal) return effect;
  if (signal.aborted)
    return Effect.fail(
      new EnvironmentRpcUnavailableError({ environmentId, message: "Speech stream stopped." }),
    );
  const aborted = Effect.callback<never, EnvironmentRpcUnavailableError>((resume) => {
    const fail = () =>
      resume(
        Effect.fail(
          new EnvironmentRpcUnavailableError({ environmentId, message: "Speech stream stopped." }),
        ),
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", fail));
  });
  return effect.pipe(Effect.raceFirst(aborted));
}

const authorizeSession = Effect.fn("liveSpeech.authorizeSession")(function* (
  session: RpcSession,
  canSend: () => boolean,
  environmentId: EnvironmentId,
) {
  if (!canSend())
    return yield* new EnvironmentAuthorizationError({
      ...authScopeRequiredResponse(AuthOrchestrationOperateScope),
      message: "Voice permission is no longer active.",
    });
  if ((yield* currentSession()) !== session)
    return yield* new EnvironmentRpcUnavailableError({
      environmentId,
      message: "The environment connection changed.",
    });
});

const prepare = createEnvironmentCommand(connectionAtomRuntime, {
  label: "speech:prepare-stream",
  execute: Effect.fn("liveSpeech.prepare")(function* () {
    const session = yield* currentSession();
    const config = yield* session.initialConfig;
    return { session, supported: config.speechStreamingV1 === true };
  }),
});
const start = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "speech:start-stream",
  tag: SPEECH_STREAM_WS_METHODS.start,
  execute: (input: Pinned<{ readonly locale: string }>, _registry, environmentId) =>
    abortable(
      authorizeSession(input.session, input.canSend, environmentId).pipe(
        Effect.andThen(
          requestInSession(input.session, SPEECH_STREAM_WS_METHODS.start, { locale: input.locale }),
        ),
      ),
      input.signal,
      environmentId,
    ),
});
const feed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "speech:feed-stream",
  tag: SPEECH_STREAM_WS_METHODS.feed,
  execute: (input: Pinned<SpeechStreamFeed>, _registry, environmentId) =>
    abortable(
      authorizeSession(input.session, input.canSend, environmentId).pipe(
        Effect.andThen(
          requestInSession(input.session, SPEECH_STREAM_WS_METHODS.feed, {
            streamId: input.streamId,
            sequence: input.sequence,
            audioBase64: input.audioBase64,
          }),
        ),
      ),
      input.signal,
      environmentId,
    ),
});
const finish = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "speech:finish-stream",
  tag: SPEECH_STREAM_WS_METHODS.finish,
  execute: (input: Pinned<{ readonly streamId: string }>, _registry, environmentId) =>
    abortable(
      authorizeSession(input.session, input.canSend, environmentId).pipe(
        Effect.andThen(
          requestInSession(input.session, SPEECH_STREAM_WS_METHODS.finish, {
            streamId: input.streamId,
          }),
        ),
      ),
      input.signal,
      environmentId,
    ),
});
const cancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "speech:cancel-stream",
  tag: SPEECH_STREAM_WS_METHODS.cancel,
  execute: (input: Pinned<{ readonly streamId: string }>, _registry, environmentId) =>
    abortable(
      authorizeSession(input.session, input.canSend, environmentId).pipe(
        Effect.andThen(
          requestInSession(input.session, SPEECH_STREAM_WS_METHODS.cancel, {
            streamId: input.streamId,
          }),
        ),
      ),
      input.signal,
      environmentId,
    ),
});

type WatchInput = Pinned<{
  readonly streamId: string;
  readonly onEvent: (event: SpeechStreamEvent) => void;
}>;
const watch = createEnvironmentCommand(connectionAtomRuntime, {
  label: "speech:watch-stream",
  execute: (input: WatchInput, registry, environmentId) => {
    const program = authorizeSession(input.session, input.canSend, environmentId).pipe(
      Effect.andThen(
        runStreamInSession(input.session, SPEECH_STREAM_WS_METHODS.events, {
          streamId: input.streamId,
        }).pipe(Stream.runForEach((event) => Effect.sync(() => input.onEvent(event)))),
      ),
      withEnvironmentRpcGuard(connectionAtomRuntime, registry),
    );
    return abortable(program, input.signal, environmentId);
  },
});

function value<A, E>(
  result: import("@goat/client-runtime/state/runtime").AtomCommandResult<A, E>,
): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function createLiveSpeechTransport(
  environmentId: EnvironmentId,
  canSend: () => boolean,
): LiveSpeechTransport {
  let session: RpcSession | undefined;
  const requireSession = () => {
    if (!session) throw new Error("Speech stream has not started.");
    return session;
  };
  return {
    async start(locale, signal) {
      const prepared = value(
        await prepare.run(appAtomRegistry, { environmentId, input: undefined }),
      );
      if (signal?.aborted || !canSend()) throw new Error("Speech stream stopped.");
      if (!prepared.supported) throw new Error("Live speech is unavailable.");
      session = prepared.session;
      return value(
        await start.run(appAtomRegistry, {
          environmentId,
          input: { session, locale, canSend, ...(signal ? { signal } : {}) },
        }),
      );
    },
    async feed(input, signal) {
      value(
        await feed.run(appAtomRegistry, {
          environmentId,
          input: { ...input, session: requireSession(), canSend, ...(signal ? { signal } : {}) },
        }),
      );
    },
    async finish(streamId, signal) {
      value(
        await finish.run(appAtomRegistry, {
          environmentId,
          input: { streamId, session: requireSession(), canSend, ...(signal ? { signal } : {}) },
        }),
      );
    },
    async cancel(streamId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LIVE_SPEECH_CANCEL_WAIT_MS);
      try {
        value(
          await cancel.run(appAtomRegistry, {
            environmentId,
            input: { streamId, session: requireSession(), canSend, signal: controller.signal },
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
    async subscribe(streamId, onEvent, onDisconnect, signal) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      let resolveReady: () => void = () => {};
      let rejectReady: (error: Error) => void = () => {};
      let ready = false;
      const established = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void watch
        .run(appAtomRegistry, {
          environmentId,
          input: {
            streamId,
            session: requireSession(),
            canSend,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "ready") {
                ready = true;
                resolveReady();
              } else onEvent(event);
            },
          },
        })
        .then((result) => {
          signal?.removeEventListener("abort", stop);
          if (!ready) rejectReady(new Error("Speech subscription ended."));
          if (!controller.signal.aborted && (result._tag === "Failure" || ready)) onDisconnect();
        });
      await established;
      return stop;
    },
  };
}
