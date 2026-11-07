import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";

export const forkCodexThread = Effect.fn("CodexAdapterV2.forkNativeThread")((
  client: CodexClient.CodexAppServerClient["Service"],
  params: CodexSchema.V2ThreadForkParams,
) => {
  const fork = client.request("thread/fork", params);
  return fork.pipe(
    Effect.catchTags({
      CodexAppServerRequestError: (cause) =>
        /\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(cause.errorMessage)
          ? client.raw
              .request("thread/unarchive", { threadId: params.threadId })
              .pipe(Effect.andThen(fork))
          : Effect.fail(cause),
    }),
  );
});
