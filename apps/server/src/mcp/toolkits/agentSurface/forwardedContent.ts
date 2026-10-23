import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

type ToolResult = McpSchema.CallToolResult | McpSchema.InputRequired;
type ContentBlock = McpSchema.CallToolResult["content"][number];

/**
 * Collects a goat_call target's non-text blocks, such as a screenshot, so they reach the caller
 * as content blocks. Inside the JSON envelope their bytes could not be encoded, and a model
 * would see base64 text instead of an image.
 */
export class ForwardedContent extends Context.Service<
  ForwardedContent,
  { readonly add: (blocks: ReadonlyArray<unknown>) => Effect.Effect<void> }
>()("goat/mcp/toolkits/agentSurface/forwardedContent") {}

const isCallToolResult = Schema.is(McpSchema.CallToolResult);

/** goat_call's registration, with its target's non-text blocks returned beside the envelope. */
export const forwardedContentRegistration = <
  P,
  E,
  R,
  Registration extends {
    readonly tool: McpSchema.Tool;
    readonly handle: (payload: P) => Effect.Effect<ToolResult, E, R>;
  },
>(
  registration: Registration,
): Registration =>
  registration.tool.name !== "goat_call"
    ? registration
    : {
        ...registration,
        // goat_call's own span already covers the call, so this wrapper adds none.
        handle: Effect.fnUntraced(function* (payload: P) {
          const collected = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const result = yield* registration.handle(payload).pipe(
            Effect.provideService(ForwardedContent, {
              add: (blocks) => Ref.update(collected, (current) => [...current, ...blocks]),
            }),
          );
          const blocks = yield* Ref.get(collected);
          if (blocks.length === 0 || !isCallToolResult(result)) return result;
          return new McpSchema.CallToolResult({
            ...result,
            content: [...result.content, ...(blocks as ReadonlyArray<ContentBlock>)],
          });
        }),
      };
