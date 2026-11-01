import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { McpSchema } from "effect/ai";

/**
 * reached: the access layer let the call into its handler, which then met inert services.
 * unexpected and defect never match an expectation, so a wrong argument or a crash before the
 * handler cannot pass as access granted.
 */
export type Outcome =
  | "thread_required"
  | "read_only"
  | "ssh_read_only"
  | "denied"
  | "uncoded"
  | "reached"
  | "unexpected"
  | "defect";
export const INERT_SERVICE_DEFECT = "inert service";
// The tool-level wrapper's text when a handler dies on an inert service.
const HANDLER_DIED = "Tool execution failed due to an internal server error.";
// Refusals a handler makes after access passed, from its own domain checks.
const HANDLER_CODES = new Set(["target_required", "orchestration_error"]);
// invalid_request from a rule the handler checks after access, on these sampled inputs.
export const HANDLER_VALIDATION: Readonly<Record<string, string>> = {
  "attachment.discard": "Only the caller that prepared an upload may discard it.",
  "thread.reschedule": "A caller outside a thread must pass a model to resume with.",
  "project.create": "A project made from a title takes no other settings.",
};
const IMAGE_TOOL_FAILURE = /^(Preview snapshot|Device screenshot) failed/;
const OPERATION_NOT_ISSUED = "No operation with that id was issued here to this caller.";
// Read from the text alone: Pi and other text-only clients never see structuredContent.
const refusalCode = (text: string) => /"code":"([a-z_]+)"/.exec(text)?.[1];
export const classify = (path: string, result: McpSchema.CallToolResult): Outcome => {
  const content = result.content[0];
  const text = content?.type === "text" ? content.text : "";
  if (!result.isError) return "reached";
  if (text === INERT_SERVICE_DEFECT || text === HANDLER_DIED) return "reached";
  if (text.startsWith("defect:")) return "defect";
  const code = refusalCode(text);
  // An agent tells a refusal from a failure by its code, so a refusal without one fails the case.
  const refused = (outcome: Outcome) => (code === undefined ? "uncoded" : outcome);
  if (/thread_credential_required|acts as the calling GOAT thread/.test(text))
    return refused("thread_required");
  if (/reaches other machines with this machine's SSH keys/.test(text))
    return refused("ssh_read_only");
  if (/approved for read-only access/.test(text)) return refused("read_only");
  if (code === "capability_denied") return "denied";
  // Operation verbs refuse a sampled handle in their handler, after access passed.
  if (path.startsWith("operation.") && text.includes(OPERATION_NOT_ISSUED)) return "reached";
  if (IMAGE_TOOL_FAILURE.test(text)) return "reached";
  if (code === "invalid_request" && path in HANDLER_VALIDATION) return "reached";
  return code !== undefined && HANDLER_CODES.has(code) ? "reached" : "unexpected";
};

// The envelope's reason and message stand in for the direct result's text. A goat_eval halt that
// may have run keeps its own code, so it never passes for the target's answer.
export const asDirectResult = (result: McpSchema.CallToolResult) => {
  const envelope = result.structuredContent as AgentSurfaceResult;
  if (envelope.status !== "error")
    return new McpSchema.CallToolResult({ isError: false, content: [] });
  const code =
    envelope.error.code === "unknown_outcome" ? "unknown_outcome" : envelope.error.reason;
  // A plain-text failure stays the direct call's own text; a classified one names its code.
  const text =
    envelope.error.reason === "tool_error"
      ? envelope.error.message
      : JSON.stringify({ code, message: envelope.error.message });
  return new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });
};

// goat_eval's own refusals and journal failures, which say nothing about the target's access.
const EVAL_OWN_FAILURE =
  /^(eval_[a-z_]+|grant_[a-z_]+|storage_failed|in_progress|idempotency_mismatch|not_callable|unknown_path|unknown_outcome)$/;

/**
 * The outcome a route's result stands for. The envelope turns a refusal inside a successful
 * value into an error; that is a domain answer after access passed, so it still counts as
 * reaching the handler, unless goat_eval itself refused before or around the call.
 */
export const routeOutcome = (options: {
  readonly route: string;
  readonly path: string;
  readonly effect: string;
  readonly classified: Outcome;
  readonly text: string;
  readonly directOutcome: Outcome | undefined;
}): Outcome => {
  const { route, path, effect, classified, text, directOutcome } = options;
  const code = refusalCode(text) ?? "";
  // goat_eval halts a write as unknown only after calling it, so a halt naming this path is the
  // target's answer; it reached the handler when the direct call did.
  if (
    route === "goat_eval" &&
    directOutcome === "reached" &&
    effect !== "read" &&
    code === "unknown_outcome" &&
    text.includes(`"message":"${path} may have run`)
  )
    return "reached";
  if (route === "goat_eval" && EVAL_OWN_FAILURE.test(code)) return classified;
  return route !== "direct" &&
    route !== "legacy" &&
    classified === "unexpected" &&
    directOutcome === "reached"
    ? "reached"
    : classified;
};
