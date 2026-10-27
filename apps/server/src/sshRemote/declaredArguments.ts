import * as Effect from "effect/Effect";

import { listAcpMcpTools } from "../mcp/AcpMcpStdioBridge.ts";

interface ToolRequest {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
}

/**
 * The request for a host tool call: its arguments plus each optional one the remote tool declares,
 * read fresh from the same endpoint and credential the call uses. An older host refuses an argument
 * it does not declare, so a missing, failed or schemaless listing sends none of them. Nothing is
 * cached because the host behind an endpoint can be upgraded or replaced between calls.
 */
export function declaredRequest(
  call: {
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly optionalArguments?: Readonly<Record<string, unknown>> | undefined;
  },
  request: ToolRequest,
  listTools: typeof listAcpMcpTools = listAcpMcpTools,
): Effect.Effect<ToolRequest & { readonly arguments: Readonly<Record<string, unknown>> }> {
  const optional = Object.entries(call.optionalArguments ?? {});
  const plain = { ...request, arguments: call.arguments };
  if (optional.length === 0) return Effect.succeed(plain);
  return listTools({ endpoint: request.endpoint, authorization: request.authorization }).pipe(
    Effect.map((tools) => {
      const declared = new Set(tools.find((tool) => tool.name === request.tool)?.argumentNames);
      const accepted = optional.filter(([name]) => declared.has(name));
      return accepted.length === 0
        ? plain
        : { ...plain, arguments: { ...call.arguments, ...Object.fromEntries(accepted) } };
    }),
    Effect.orElseSucceed(() => plain),
  );
}
