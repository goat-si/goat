import type { ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";

export const startCodexThread = Effect.fn("CodexDelegatedSource.startThread")(
  (
    client: CodexClient.CodexAppServerClient["Service"],
    threadId: ThreadId,
    params: CodexSchema.V2ThreadStartParams,
  ) =>
    client
      .request("thread/start", {
        ...params,
        ...(IdAllocator.isDelegatedTaskThread(threadId)
          ? { threadSource: "subagent" as const }
          : {}),
      })
      .pipe(
        Effect.catchTags({
          CodexAppServerRequestError: (error) =>
            IdAllocator.isDelegatedTaskThread(threadId) &&
            error.code === -32602 &&
            /thread.?source/i.test(error.errorMessage)
              ? client.request("thread/start", params)
              : Effect.fail(error),
        }),
      ),
);
