/**
 * Every tool /mcp serves is registered through guardedToolRegistration, so a call on an MCP client
 * session stops when that session is revoked or expires. Thread credentials carry no
 * session end and are never cut. Nested calls (goat_call, goat_eval steps) stop with their parent.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";

import { McpInvocationContext } from "./McpInvocationContext.ts";
import { tracedToolRegistration } from "./toolSpans.ts";

/** Set inside a guarded call, so a nested call does not race the same session end again. */
const InsideGuardedCall = Context.Reference<boolean>("goat/mcp/McpSessionCut/InsideGuardedCall", {
  defaultValue: () => false,
});

const cutResult = (readOnly: boolean) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [
      {
        type: "text",
        text: readOnly
          ? "This GOAT session was revoked or expired while the call ran, so GOAT stopped it. Nothing changed."
          : "This GOAT session was revoked or expired while the call ran, so GOAT stopped it. Work it had started may have finished; check before repeating it with a new sign-in.",
      },
    ],
  });

type ToolResult = McpSchema.CallToolResult | McpSchema.InputRequired;

/** tracedToolRegistration plus the session cut; McpHttpServer applies it to every tool last. */
export const guardedToolRegistration = <
  P,
  E,
  R,
  Registration extends {
    readonly tool: McpSchema.Tool;
    readonly handle: (payload: P) => Effect.Effect<ToolResult, E, R>;
  },
>(
  registration: Registration,
): Registration => {
  const traced = tracedToolRegistration<P, ToolResult, E, R, Registration>(registration);
  const readOnly = registration.tool.annotations?.readOnlyHint === true;
  return {
    ...traced,
    // The traced handle already opens this call's span.
    handle: Effect.fnUntraced(function* (payload: P) {
      const scope = yield* Effect.serviceOption(McpInvocationContext);
      const sessionEnd = Option.isSome(scope) ? scope.value.sessionEnd : undefined;
      if (sessionEnd === undefined || (yield* InsideGuardedCall))
        return yield* traced.handle(payload);
      const result = yield* sessionEnd.run(
        traced.handle(payload).pipe(Effect.provideService(InsideGuardedCall, true)),
      );
      return Option.isSome(result) ? result.value : cutResult(readOnly);
    }),
  };
};
