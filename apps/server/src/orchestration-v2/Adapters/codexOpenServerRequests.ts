import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

type Client = CodexClient.CodexAppServerClient["Service"];

const nativeThreadOf = (payload: unknown) => {
  if (!Predicate.isObject(payload)) return undefined;
  if (typeof payload.threadId === "string") return payload.threadId;
  // Legacy approvals name the thread as their conversation.
  return typeof payload.conversationId === "string" ? payload.conversationId : undefined;
};

/**
 * Native threads with a server request Codex still holds open. Codex ends every request, whether
 * answered, interrupted or dropped, with serverRequest/resolved, sometimes after the asking turn
 * has ended; unloading the thread before that would drop a request a person may still answer.
 */
export const trackOpenServerRequests = Effect.fn("CodexOpenServerRequests.track")(function* (
  client: Client,
) {
  const open = new Map<string, number>();
  const change = (threadId: string, delta: number) => {
    const next = (open.get(threadId) ?? 0) + delta;
    if (next > 0) open.set(threadId, next);
    else open.delete(threadId);
  };
  yield* client.handleServerNotification("serverRequest/resolved", (payload) =>
    Effect.sync(() => change(payload.threadId, -1)),
  );
  const handleServerRequest: Client["handleServerRequest"] = (method, handler) =>
    client.handleServerRequest(method, (payload) =>
      Effect.suspend(() => {
        const threadId = nativeThreadOf(payload);
        if (threadId !== undefined) change(threadId, 1);
        return handler(payload);
      }),
    );
  return { handleServerRequest, openThreads: () => Array.from(open.keys()) };
});
