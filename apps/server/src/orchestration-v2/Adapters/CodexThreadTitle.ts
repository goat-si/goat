import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";

export function makeCodexThreadTitle(client: CodexClient.CodexAppServerClient["Service"]) {
  const applied = new Map<string, string>();
  return Effect.fn("CodexAdapterV2.applyThreadName")(function* (threadId: string, title: string) {
    if (applied.get(threadId) === title) return;
    const renamed = yield* client
      .request("thread/name/set", { threadId, name: title })
      .pipe(Effect.timeout("10 seconds"), Effect.result);
    if (renamed._tag === "Failure") {
      applied.delete(threadId);
      yield* Effect.logWarning("Codex thread title could not be applied", { threadId });
      return;
    }
    if (applied.size >= 512 && !applied.has(threadId)) {
      const oldest = applied.keys().next().value;
      if (oldest !== undefined) applied.delete(oldest);
    }
    applied.set(threadId, title);
  });
}
