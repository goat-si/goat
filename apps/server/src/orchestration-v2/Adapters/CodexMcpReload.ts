import * as CodexError from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isRequestError = Schema.is(CodexError.CodexAppServerRequestError);

export const withCodexMcpReload = <A, E, R, E2, R2>(
  threadId: string,
  request: Effect.Effect<A, E, R>,
  resume: Effect.Effect<unknown, E2, R2>,
) =>
  request.pipe(
    Effect.catchIf(
      (error) =>
        isRequestError(error) &&
        error.code === -32600 &&
        error.errorMessage === `thread not found: ${threadId}`,
      () => resume.pipe(Effect.andThen(request)),
    ),
  );
