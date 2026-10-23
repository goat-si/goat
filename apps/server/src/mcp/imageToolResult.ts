import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const encodeOrchestratorMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);
const isCapabilityError = Schema.is(
  Schema.Union([McpCapabilityUnavailableError, PreviewAutomationUnavailableError]),
);

function refusalFields(
  error: unknown,
): (Readonly<Record<string, unknown>> & { readonly message: string }) | undefined {
  if (isOrchestratorMcpFailure(error)) return encodeOrchestratorMcpFailure(error);
  if (isCapabilityError(error))
    return { _tag: error._tag, capability: error.capability, message: error.message };
  return undefined;
}

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag unless the tool describes them: the remote
 * message may carry renderer or device output the agent should not see, and the
 * tag is what it can act on. Refusals written for the agent, such as a missing
 * thread credential, keep their code and message so it can tell them apart.
 */
export const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const refusal = failures[0] === undefined ? undefined : refusalFields(failures[0].error);
    const message =
      refusal?.message ??
      (typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error));
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...refusal,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text:
            refusal?.message ??
            (typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`)),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/** An image tool's result as image content, with its metadata beside it as JSON. */
export const imageToolSuccess = (payload: unknown, encodedResult: unknown) => {
  const { screenshot, ...rest } = encodedResult as ImageToolResult;
  const includeImage =
    (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !== false;
  const metadata = {
    ...rest,
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
    },
  };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...(includeImage
        ? [
            {
              type: "image" as const,
              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
              mimeType: screenshot.mimeType,
            },
          ]
        : []),
    ],
  });
};
