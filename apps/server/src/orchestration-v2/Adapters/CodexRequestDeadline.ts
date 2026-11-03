import { makeFiniteRequestGuard } from "@goat/provider-core/server/finiteProviderRequest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

export const withCodexRequestDeadlines = Effect.fn("CodexRequestDeadline.wrap")(function* (
  rawClient: CodexClient.CodexAppServerClient["Service"],
) {
  const scope = yield* Effect.scope;
  const requestGuard = yield* makeFiniteRequestGuard({
    liveness: {
      retiresAlone: (method) => method === "initialize",
      scope,
      window: "60 seconds",
      probe: rawClient.request("config/read", { cwd: null, includeLayers: false }).pipe(
        Effect.asVoid,
        Effect.catch((error) => (isRequestError(error) ? Effect.void : Effect.never)),
      ),
    },
    duration: (method) => {
      switch (method) {
        case "initialize":
        case "turn/start":
          return "60 seconds";
        case "thread/start":
        case "thread/resume":
        case "thread/fork":
          return "90 seconds";
        case "config/read":
        case "thread/read":
        case "turn/steer":
        case "turn/interrupt":
        case "thread/unsubscribe":
        case "thread/goal/set":
        case "thread/goal/clear":
        case "thread/compact/start":
          return "30 seconds";
        default:
          return undefined;
      }
    },
    error: (method) =>
      new CodexErrors.CodexAppServerTransportError({
        operation: "read-input-stream",
        cause: { category: "request-deadline", method },
      }),
  });
  const markAnswers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tap(() => requestGuard.heard),
      Effect.tapError((error) => (isRequestError(error) ? requestGuard.heard : Effect.void)),
    );
  const client = CodexClient.CodexAppServerClient.of({
    ...rawClient,
    request: Effect.fn("CodexRequestDeadline.request")((method, payload) =>
      requestGuard.request(method, markAnswers(rawClient.request(method, payload))),
    ),
    raw: {
      ...rawClient.raw,
      request: Effect.fn("CodexRequestDeadline.rawRequest")((method, payload) =>
        requestGuard.request(method, markAnswers(rawClient.raw.request(method, payload))),
      ),
    },
    handleServerNotification: Effect.fn("CodexRequestDeadline.handleServerNotification")(
      (method, handler) =>
        rawClient.handleServerNotification(method, (payload) =>
          requestGuard.heard.pipe(Effect.andThen(handler(payload))),
        ),
    ),
    handleServerRequest: Effect.fn("CodexRequestDeadline.handleServerRequest")((method, handler) =>
      rawClient.handleServerRequest(method, (payload) =>
        requestGuard.heard.pipe(Effect.andThen(handler(payload))),
      ),
    ),
    handleUnknownServerNotification: Effect.fn(
      "CodexRequestDeadline.handleUnknownServerNotification",
    )((handler) =>
      rawClient.handleUnknownServerNotification((method, params) =>
        requestGuard.heard.pipe(Effect.andThen(handler(method, params))),
      ),
    ),
    handleUnknownServerRequest: Effect.fn("CodexRequestDeadline.handleUnknownServerRequest")(
      (handler) =>
        rawClient.handleUnknownServerRequest((method, params) =>
          requestGuard.heard.pipe(Effect.andThen(handler(method, params))),
        ),
    ),
    terminated: Effect.raceFirst(rawClient.terminated, requestGuard.terminated),
  });
  return Object.assign(client, {
    requestTurnStart: (
      payload: CodexSchema.V2TurnStartParams,
      onLate: (turnId: string) => Effect.Effect<void>,
    ) =>
      requestGuard.request(
        "turn/start",
        markAnswers(rawClient.request("turn/start", payload)),
        (result) => onLate(result.turn.id),
      ),
  });
});
