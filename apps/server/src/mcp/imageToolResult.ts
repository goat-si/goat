import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewAutomationUnavailableError,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
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

// Clients such as Pi show the model only the text when there is any, so a refusal's text is
// its JSON envelope, as every other tool's refusal is, and its code survives text-only clients.
const refusalText = (refusal: Readonly<Record<string, unknown>>) => JSON.stringify(refusal);

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

// Effect's registerToolkit answers a dying handler with this text; image tools register directly
// and must answer the same way, as a tool result an agent can retry or report (#907).
const HANDLER_DIED_TEXT = "Tool execution failed due to an internal server error.";

/**
 * Interruption still propagates. A handler defect is logged, reported, and becomes an error result
 * instead of the JSON-RPC internal error some MCP clients treat as the whole server failing.
 */
const dyingHandler = <E>(cause: Cause.Cause<E>, toolName: string) =>
  Cause.hasInterrupts(cause)
    ? Effect.failCause(cause).pipe(Effect.orDie)
    : Effect.logError(`${toolName} handler died`, cause).pipe(
        Effect.andThen(ErrorReporter.report(cause)),
        Effect.as(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: HANDLER_DIED_TEXT }],
          }),
        ),
      );

export const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return dyingHandler(cause, "preview_snapshot");
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const refusal = refusalFields(firstFailure);
  const message =
    refusal?.message ?? (isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined);
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
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
          refusal === undefined
            ? `Preview snapshot failed: ${message ?? `${errorTag}.`}`
            : refusalText(refusal),
      },
    ],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

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
      return dyingHandler(cause, toolName);
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
            refusal === undefined
              ? typeof failureText === "string"
                ? failureText
                : (message ?? `${toolName} failed.`)
              : refusalText(refusal),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * An image tool's result as image content, with its metadata beside it as JSON text. With an
 * image, structuredContent stays empty: Codex then sends the model only that JSON, never the image.
 */
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
    ...(includeImage ? {} : { structuredContent: metadata }),
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
