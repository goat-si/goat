/**
 * The agent cursor tools, answered by the proxy. On macOS the driver runs without an overlay of
 * its own and refuses them; GOAT's helper draws the agent cursor instead, so the proxy
 * reports and toggles that cursor. The driver's listing of these tools is rewritten to match.
 *
 * @module ComputerUseCursorTools
 */
// JSON-RPC lines pass through unchanged apart from the cursor tools in a tool listing.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";

import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";

export interface HelperCursor {
  readonly view: () => { readonly enabled: boolean; readonly visible: boolean };
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
}

const FIXED_STYLE =
  "GOAT's on-screen agent cursor keeps one fixed look and motion, so this changes nothing and answers applied: false.";

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  get_agent_cursor_state:
    "Reports GOAT's on-screen agent cursor for this control: whether it is enabled (it is by default) and visible now. GOAT draws it on the window you act on and hides it for every capture. get_config's agent_cursor describes the driver's own overlay, which GOAT does not use.",
  set_agent_cursor_enabled:
    "Turns GOAT's on-screen agent cursor on or off for the rest of this control; it starts on. GOAT's own live view keeps showing where you act either way.",
  set_agent_cursor_motion: FIXED_STYLE,
  set_agent_cursor_theme: FIXED_STYLE,
};

export const AGENT_CURSOR_TOOLS: ReadonlySet<string> = new Set(Object.keys(DESCRIPTIONS));

/** Every answer, including the proxy's and the driver's refusals, matches the listed schema. */
export const CURSOR_OUTPUT_SCHEMA = {
  type: "object",
  anyOf: [
    {
      type: "object",
      properties: {
        session: { type: "string" },
        enabled: { type: "boolean" },
        visible: { type: "boolean" },
        drawn_by: { const: "goat_helper" },
        applied: { type: "boolean" },
      },
      required: ["session", "enabled", "visible", "drawn_by"],
    },
    {
      type: "object",
      additionalProperties: true,
      anyOf: [
        { required: ["refused"] },
        { required: ["code"] },
        { required: ["status"] },
        { required: ["refusal"] },
      ],
    },
  ],
} as const;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** A tool listing with the cursor tools described as GOAT answers them; other lines unchanged. */
export function helperCursorListing(line: string): string {
  if (!line.includes("agent_cursor")) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const result = record(record(message)?.result);
  if (!Array.isArray(result?.tools)) return line;
  const tools = result.tools.map((tool: unknown) => {
    const entry = record(tool);
    const name = entry?.name;
    if (typeof name !== "string" || !AGENT_CURSOR_TOOLS.has(name)) return tool;
    return { ...entry, description: DESCRIPTIONS[name], outputSchema: CURSOR_OUTPUT_SCHEMA };
  });
  return JSON.stringify({ ...record(message), result: { ...result, tools } });
}

const reply = (id: JsonRpcId, text: string, structuredContent: object, isError = false) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      structuredContent,
      ...(isError ? { isError } : {}),
    },
  });

/** Answers one cursor tool call from the helper's cursor, toggling it first when asked. */
export const answerCursorTool = Effect.fn("ComputerUseCursorTools.answer")(function* (
  id: JsonRpcId,
  name: string,
  args: unknown,
  cursor: HelperCursor,
) {
  const input = record(args);
  const session = typeof input?.session === "string" ? input.session : "default";
  if (name === "set_agent_cursor_enabled") {
    const enabled = input?.enabled;
    if (typeof enabled !== "boolean")
      return reply(
        id,
        "set_agent_cursor_enabled needs enabled: true or false.",
        { code: "invalid_arguments", message: "enabled must be a boolean" },
        true,
      );
    yield* cursor.setEnabled(enabled);
  }
  const state = { session, ...cursor.view(), drawn_by: "goat_helper" };
  if (name === "set_agent_cursor_motion" || name === "set_agent_cursor_theme")
    return reply(id, FIXED_STYLE, { ...state, applied: false });
  const shown = state.visible ? "on screen now" : "not on screen now";
  return reply(
    id,
    `GOAT's agent cursor is ${state.enabled ? "enabled" : "disabled"} and ${shown}.`,
    state,
  );
});
