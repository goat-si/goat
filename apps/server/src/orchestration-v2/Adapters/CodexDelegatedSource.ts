import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";

export const startCodexThread = Effect.fn("CodexDelegatedSource.startThread")(
  (
    client: CodexClient.CodexAppServerClient["Service"],
    isAppOwnedDelegated: boolean,
    params: CodexSchema.V2ThreadStartParams,
  ) =>
    client
      .request("thread/start", {
        ...params,
        ...(isAppOwnedDelegated ? { threadSource: "subagent" as const } : {}),
      })
      .pipe(
        Effect.catchTags({
          CodexAppServerRequestError: (error) =>
            isAppOwnedDelegated &&
            (error.code === -32602 || error.code === -32600) &&
            /thread.?source/i.test(error.errorMessage) &&
            /unknown field|unrecognized|unsupported/i.test(error.errorMessage)
              ? client.request("thread/start", params)
              : Effect.fail(error),
        }),
      ),
);
