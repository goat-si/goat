import { CommandId } from "@goat/contracts";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

/** Ids derived from the caller's request namespace and key, so a retried call replays its receipt. */
export function stablePart(value: string): string {
  return encodeURIComponent(value);
}

export function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}
