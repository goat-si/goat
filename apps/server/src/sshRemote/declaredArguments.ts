import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { listAcpMcpTools } from "../mcp/AcpMcpStdioBridge.ts";

export const DECLARED_ARGUMENTS_TIMEOUT = "5 seconds";

export class HostRoutableDeclarationError extends Error {
  readonly reason: "remote_outdated" | "host_unavailable";

  constructor(reason: "remote_outdated" | "host_unavailable", message: string) {
    super(message);
    this.reason = reason;
  }
}

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
    readonly host?: string | undefined;
    readonly requireHostRoutable?: true | undefined;
  },
  request: ToolRequest,
  listTools: typeof listAcpMcpTools = listAcpMcpTools,
): Effect.Effect<
  ToolRequest & { readonly arguments: Readonly<Record<string, unknown>> },
  HostRoutableDeclarationError
> {
  const optional = Object.entries(call.optionalArguments ?? {});
  const plain = { ...request, arguments: call.arguments };
  const required = call.requireHostRoutable === true;
  if (optional.length === 0 && !required) return Effect.succeed(plain);
  const listed = listTools({
    endpoint: request.endpoint,
    authorization: request.authorization,
    ...(required ? { strict: true } : {}),
  }).pipe(
    // A host that answers slowly sends without the optional metadata rather than holding the call.
    Effect.timeoutOption(DECLARED_ARGUMENTS_TIMEOUT),
  );
  if (required) {
    const destination = call.host ?? request.endpoint;
    return listed.pipe(
      Effect.flatMap((response) => {
        if (Option.isNone(response))
          return Effect.fail(
            new HostRoutableDeclarationError(
              "host_unavailable",
              `Could not verify that GOAT on ${destination} supports host routing for ${request.tool}; nothing ran.`,
            ),
          );
        const declaration = response.value.find((tool) => tool.name === request.tool);
        if (declaration === undefined || !declaration.argumentNames.includes("host"))
          return Effect.fail(
            new HostRoutableDeclarationError(
              "remote_outdated",
              `GOAT on ${destination} does not have ${request.tool} with host routing. Update GOAT on ${destination}; nothing ran.`,
            ),
          );
        const declared = new Set(declaration.argumentNames);
        const accepted = optional.filter(([name]) => declared.has(name));
        return Effect.succeed(
          accepted.length === 0
            ? plain
            : { ...plain, arguments: { ...call.arguments, ...Object.fromEntries(accepted) } },
        );
      }),
      Effect.mapError((error) =>
        error instanceof HostRoutableDeclarationError
          ? error
          : new HostRoutableDeclarationError(
              "host_unavailable",
              `Could not verify that GOAT on ${destination} supports host routing for ${request.tool}; nothing ran.`,
            ),
      ),
    );
  }
  return listed.pipe(
    Effect.map((listed) => {
      if (Option.isNone(listed)) return plain;
      const tools = listed.value;
      const declared = new Set(tools.find((tool) => tool.name === request.tool)?.argumentNames);
      const accepted = optional.filter(([name]) => declared.has(name));
      return accepted.length === 0
        ? plain
        : { ...plain, arguments: { ...call.arguments, ...Object.fromEntries(accepted) } };
    }),
    Effect.orElseSucceed(() => plain),
  );
}
