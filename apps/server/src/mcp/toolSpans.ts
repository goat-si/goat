import * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

export const tracedToolRegistration = <
  P,
  A,
  E,
  R,
  T extends {
    readonly tool: McpSchema.Tool;
    readonly handle: (payload: P) => Effect.Effect<A, E, R>;
  },
>(
  registration: T,
): T => ({
  ...registration,
  // The toolkit annotates its current span with arguments; keep those off this span.
  handle: (payload: P) =>
    Effect.useSpan(
      `mcp.tool.${registration.tool.name}`,
      {
        attributes: {
          "rpc.system": "mcp",
          "rpc.method": "tools/call",
          "mcp.tool.name": registration.tool.name,
        },
      },
      () => registration.handle(payload),
    ),
});
