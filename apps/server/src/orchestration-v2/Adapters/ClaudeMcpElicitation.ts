import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import { toMcpElicitationResponse } from "../../provider/CodexMcpElicitation.ts";

type ClaudeMcpElicitationContent = NonNullable<ElicitationResult["content"]>;

const isClaudeMcpElicitationValue = (
  value: unknown,
): value is ClaudeMcpElicitationContent[string] =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const withoutSchemaDefaults = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        typeof field === "object" && field !== null
          ? Object.fromEntries(Object.entries(field).filter(([name]) => name !== "default"))
          : field,
      ]),
    ),
  };
};

// The card collects consent only; schema defaults must never grant unseen permissions.
export function claudeMcpElicitationAcceptance(
  request: ElicitationRequest,
): ElicitationResult | undefined {
  if (request.mode === "url" || request.requestedSchema === undefined) return undefined;
  const response = toMcpElicitationResponse(
    { mode: "form", requestedSchema: withoutSchemaDefaults(request.requestedSchema) },
    "accept",
  );
  // The helper leaves content out when the schema is not a form it can read.
  const filled = response.content;
  if (
    response.action !== "accept" ||
    typeof filled !== "object" ||
    filled === null ||
    Array.isArray(filled)
  ) {
    return undefined;
  }
  const content: ClaudeMcpElicitationContent = {};
  for (const [key, value] of Object.entries(filled)) {
    if (!isClaudeMcpElicitationValue(value)) return undefined;
    content[key] = value;
  }
  return { action: "accept", content };
}
