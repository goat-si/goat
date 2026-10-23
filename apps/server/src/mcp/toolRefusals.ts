import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as McpToolAccess from "./McpToolAccess.ts";

/** Results for calls refused before a tool runs, in the shape SshRemoteDispatch reads back. */
const encodeOrchestratorMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
export const encodeReferenceRefusal = Schema.encodeSync(
  Schema.fromJsonString(OrchestratorMcpFailure),
);

export const refusalResult = (failure: OrchestratorMcpFailure) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(encodeOrchestratorMcpFailure(failure)) }],
  });

/**
 * Effect's MCP server answers a declared failure with only its message, so a refusal from a
 * toolkit that fails instead of returning its errors would reach the agent without its code.
 * The access layer reports each original failure through CallFailureCapture; this reads that
 * report, passes it on to an enclosing goat_call, and answers such a refusal with its code.
 */
export const keepingRefusalCode =
  <E, R>(handle: (payload: unknown) => Effect.Effect<McpSchema.CallToolResult, E, R>) =>
  (payload: unknown) =>
    // Request instrumentation already owns the span for each tool call.
    Effect.fnUntraced(function* () {
      const outer = yield* Effect.serviceOption(McpToolAccess.CallFailureCapture);
      const captured = yield* Ref.make<unknown>(undefined);
      const result = yield* handle(payload).pipe(
        Effect.provideService(McpToolAccess.CallFailureCapture, {
          record: (error) =>
            Ref.set(captured, error).pipe(
              Effect.andThen(Option.isSome(outer) ? outer.value.record(error) : Effect.void),
            ),
        }),
      );
      const error = yield* Ref.get(captured);
      const [only] = result.content;
      const flattened =
        result.isError === true &&
        result.structuredContent === undefined &&
        result.content.length === 1 &&
        only?.type === "text" &&
        isOrchestratorMcpFailure(error) &&
        only.text === error.message;
      return flattened ? refusalResult(error) : result;
    })();

export const undeclaredArgumentsResult = (
  tool: string,
  undeclared: ReadonlyArray<string>,
  declared: ReadonlyArray<string>,
) => {
  const accepted =
    declared.length === 0 ? `${tool} takes no arguments.` : `It takes ${declared.join(", ")}.`;
  const failure = new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `${tool} does not take ${undeclared.join(", ")}, so nothing ran. ${accepted}`,
  });
  return new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(encodeOrchestratorMcpFailure(failure)) }],
  });
};

export const argumentKeys = (payload: unknown) =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
