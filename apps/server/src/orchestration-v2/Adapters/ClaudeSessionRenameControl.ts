import type { Query as ClaudeQuery } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { queryRunnerError } from "./ClaudeQueryRunnerErrors.ts";

export const renameClaudeSession = (query: ClaudeQuery, title: string) =>
  Effect.tryPromise({
    try: async () => {
      const request: unknown = Reflect.get(query, "request");
      if (typeof request !== "function")
        throw new Error("This Claude Agent SDK cannot rename sessions.");
      await Reflect.apply(request, query, [{ subtype: "rename_session", title, source: "host" }]);
    },
    catch: (cause) => queryRunnerError(cause, "renameSession"),
  });
