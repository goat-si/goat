import { makeFiniteRequestGuard } from "@goat/provider-core/server/finiteProviderRequest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

export const withCodexRequestDeadlines = Effect.fn("CodexRequestDeadline.wrap")(function* (
  rawClient: CodexClient.CodexAppServerClient["Service"],
) {
  const requestGuard = yield* makeFiniteRequestGuard({
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
  return CodexClient.CodexAppServerClient.of({
    ...rawClient,
    request: Effect.fn("CodexRequestDeadline.request")((method, payload) =>
      requestGuard.request(method, rawClient.request(method, payload)),
    ),
    raw: {
      ...rawClient.raw,
      request: Effect.fn("CodexRequestDeadline.rawRequest")((method, payload) =>
        requestGuard.request(method, rawClient.raw.request(method, payload)),
      ),
    },
    terminated: Effect.raceFirst(rawClient.terminated, requestGuard.terminated),
  });
});
