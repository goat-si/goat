/**
 * What an input tool's error from the macOS driver means to the agent. The driver forwards
 * AXUIElementPerformAction errors as plain tool failures, yet kAXErrorCannotComplete "does not
 * necessarily mean that the function has failed" (Apple, AXUIElementPerformAction): a Finder
 * AXOpen landed and still answered -25205. An agent that reads a plain failure retries and acts
 * twice, so an input error the driver raised after input may have left is marked unverifiable,
 * as Linux's action results already are (packages/shared/src/computerUseActions.ts).
 *
 * @module ComputerUseDriverOutcome
 */
// Driver lines are forwarded as written; only an input error's result fields are read.
// @effect-diagnostics preferSchemaOverJson:off
import { PRE_DISPATCH_CODES } from "@goat/shared/computerUseActions";

import { READ_ONLY_TOOLS } from "./ComputerUseLeaseMessages.ts";

export { driverExitReason } from "./ComputerUseDriverExit.ts";

const UNVERIFIED_INPUT_NOTE =
  "GOAT: this input was already sent when the driver reported the error, so it may have acted. Do not resend it unchanged; observe the window before retrying.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The driver's reply to an input tool, with effect "unverifiable" added when it may have acted. */
export function markUnverified(tool: string | undefined, line: string): string {
  if (tool === undefined || READ_ONLY_TOOLS.has(tool)) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(message) || !isRecord(message.result) || message.result.isError !== true)
    return line;
  const result = message.result;
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const code = structured.code;
  if (structured.effect !== undefined || structured.status === "refused") return line;
  if (typeof code === "string" && PRE_DISPATCH_CODES.has(code)) return line;
  const content = Array.isArray(result.content) ? result.content : [];
  return JSON.stringify({
    ...message,
    result: {
      ...result,
      content: [...content, { type: "text", text: UNVERIFIED_INPUT_NOTE }],
      structuredContent: { ...structured, effect: "unverifiable" },
    },
  });
}
