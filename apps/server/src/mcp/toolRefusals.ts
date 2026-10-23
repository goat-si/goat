import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

/** Results for calls refused before a tool runs, in the shape SshRemoteDispatch reads back. */
const encodeOrchestratorMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);
export const encodeReferenceRefusal = Schema.encodeSync(
  Schema.fromJsonString(OrchestratorMcpFailure),
);

export const refusalResult = (failure: OrchestratorMcpFailure) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(encodeOrchestratorMcpFailure(failure)) }],
  });

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
