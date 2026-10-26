import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { LaunchWatchServiceShape } from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { watchKeyOf } from "./launchWatchRearm.ts";

export const routePendingRead = Effect.fn("HostThreadsMcpService.routePendingRead")(function* <
  T extends {
    readonly host: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly environmentId?: import("@goat/contracts").EnvironmentId | null;
  },
>(watches: LaunchWatchServiceShape, scope: McpInvocationScope, input: T) {
  if (
    input.environmentId != null ||
    (input.tool !== "goat_pending_request_list" && input.tool !== "goat_pending_request_read") ||
    typeof input.arguments.threadId !== "string"
  )
    return input;
  const watch = yield* watches.find(
    watchKeyOf(scope, { host: input.host, threadId: ThreadId.make(input.arguments.threadId) }),
  );
  return { ...input, environmentId: watch?.sourceEnvironmentId ?? null };
});
