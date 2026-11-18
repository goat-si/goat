import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";

const MAX_CLOSINGS = 256;

export function makeCodexThreadClosings() {
  const pending = new Map<string, Deferred.Deferred<void>>();
  const close = Effect.fn("CodexThreadClosings.close")(function* (threadId: string) {
    const closing = pending.get(threadId);
    pending.delete(threadId);
    if (closing !== undefined) yield* Deferred.succeed(closing, undefined);
  });
  const begin = Effect.fn("CodexThreadClosings.begin")(function* (threadId: string) {
    if (pending.has(threadId)) return;
    let evicted: Deferred.Deferred<void> | undefined;
    if (pending.size >= MAX_CLOSINGS) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) {
        evicted = pending.get(oldest);
        pending.delete(oldest);
      }
    }
    pending.set(threadId, Deferred.makeUnsafe<void>());
    if (evicted !== undefined) yield* Deferred.succeed(evicted, undefined);
  });
  const wait = Effect.fn("CodexThreadClosings.wait")(function* (threadId: string) {
    const closing = pending.get(threadId);
    if (closing === undefined) return;
    yield* Deferred.await(closing).pipe(Effect.timeoutOption("10 seconds"));
    if (pending.get(threadId) === closing) pending.delete(threadId);
  });
  // Codex refuses thread/resume while an unsubscribed thread is closing; a resume waits for it.
  const unsubscribe = Effect.fn("CodexThreadClosings.unsubscribe")(function* (
    client: CodexClient.CodexAppServerClient["Service"],
    threadId: string,
  ) {
    yield* begin(threadId);
    yield* client
      .request("thread/unsubscribe", { threadId })
      .pipe(Effect.onError(() => close(threadId)));
  });
  return { begin, close, wait, unsubscribe };
}
