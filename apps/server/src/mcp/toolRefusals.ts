import { OrchestratorMcpFailure } from "@goat/contracts";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as McpToolAccess from "./McpToolAccess.ts";

/** Results for calls refused before a tool runs, in the shape SshRemoteDispatch reads back. */
const encodeOrchestratorMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const isCallToolResult = Schema.is(McpSchema.CallToolResult);
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
  <P, A, E, R>(handle: (payload: P) => Effect.Effect<A, E, R>) =>
  (payload: P) =>
    Effect.gen(function* () {
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
      if (!isCallToolResult(result)) return result;
      const [only] = result.content;
      const flattened =
        result.isError === true &&
        result.structuredContent === undefined &&
        result.content.length === 1 &&
        only?.type === "text" &&
        isOrchestratorMcpFailure(error) &&
        only.text === error.message;
      return flattened ? refusalResult(error) : result;
    });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Refuses top-level arguments a tool does not declare. The tool is named as /mcp lists it, since
 * the registration keeps its shipped name and a refusal under that name sends the agent back to a
 * name it can no longer see. An object wrapped in args or arguments alone is goat_call's shape;
 * the refusal says so but still refuses, so a direct call keeps its strict arguments.
 */
export const undeclaredArgumentsResult = (
  registered: string,
  payload: unknown,
  undeclared: ReadonlyArray<string>,
  declared: ReadonlyArray<string>,
) => {
  const entry = resolveAgentSurfaceEntry(registered);
  const tool = entry === undefined ? registered : listedToolName(entry);
  const accepted =
    declared.length === 0 ? `${tool} takes no arguments.` : `It takes ${declared.join(", ")}.`;
  const [only] = undeclared;
  const wrapped =
    undeclared.length === 1 &&
    (only === "args" || only === "arguments") &&
    isRecord(payload) &&
    isRecord(payload[only]);
  const path = entry === undefined ? "path" : `path: "${entry.path}"`;
  const unwrap = wrapped
    ? ` ${only} wraps arguments only for goat_call {${path}, args: {...}}; call ${tool} with its fields at the top level instead.`
    : "";
  const failure = new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `${tool} does not take ${undeclared.join(", ")}, so nothing ran. ${accepted}${unwrap}`,
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
