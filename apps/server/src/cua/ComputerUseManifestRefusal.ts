/**
 * The driver refuses what GOAT's capability manifest leaves out with permission_denied, the code
 * of a missing macOS grant too (server.rs authorize_tool_call). Typed as outside_manifest so an
 * agent does not send the person to Privacy & Security. @module ComputerUseManifestRefusal
 */
// Driver lines are forwarded as written; only a refused result's code and message are read.
// @effect-diagnostics preferSchemaOverJson:off
import { computerUseRefusalReason } from "@goat/contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const NOTE =
  "GOAT: this is outside what GOAT lets agents do with computer use on this host, not a missing macOS permission. Do not ask the person to change Privacy & Security for it. If the app opened after computer use started, ask for it with goat_computer_use_request; once it is available, observe it again before acting on it. Otherwise use another route or tell the person.";

const texts = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((item) => (isRecord(item) && typeof item.text === "string" ? [item.text] : []))
    : [];

/** The driver's reply to a tools/call, with GOAT's typed refusal added for a manifest denial. */
export function typeManifestRefusal(line: string): string {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(message) || !isRecord(message.result)) return line;
  const result = message.result;
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (result.isError !== true || structured === undefined || "refused" in structured) return line;
  const nested = isRecord(structured.refusal) ? structured.refusal : {};
  if (structured.code !== "permission_denied" && nested.code !== "permission_denied") return line;
  const said = [...texts(result.content), typeof nested.message === "string" ? nested.message : ""];
  if (!said.some((text) => text.includes("capability manifest"))) return line;
  const content = Array.isArray(result.content) ? result.content : [];
  return JSON.stringify({
    ...message,
    result: {
      ...result,
      content: [...content, { type: "text", text: NOTE }],
      structuredContent: {
        ...structured,
        refused: computerUseRefusalReason("outside_manifest"),
        detail: "outside_manifest",
      },
    },
  });
}
