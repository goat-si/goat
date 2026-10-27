/**
 * Driver Apple Events refusals as GOAT's: automation_denied (consent off) is permissionsNotGranted,
 * automation_timeout (no answer in time, as with an unanswered prompt) is permissionsPending.
 * automation_failed (app not running, no document, a script error) says nothing about consent.
 * @module ComputerUseAutomationRefusal
 */
// Driver lines are forwarded as written; only a refused result's code fields are read.
// @effect-diagnostics preferSchemaOverJson:off
import {
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
  type CuaAgentPermissionsBlock,
  cuaAgentBlockMessage,
} from "@goat/contracts";

import { targetPid } from "./ComputerUseScope.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The pinned driver's tools whose routes can send Apple Events (tools/invoke_menu.rs, set_value.rs). */
const APPLE_EVENT_TOOLS: ReadonlySet<string> = new Set(["invoke_menu", "set_value"]);

/**
 * Whether this call may need Apple Events for an app the proxy cannot name yet. A call by element
 * token alone names no pid, and other answers can drop the app's entry, so it always lists.
 */
export const sendsAppleEvents = (
  name: unknown,
  args: unknown,
  listed: ReadonlyMap<number, unknown>,
): boolean => {
  if (typeof name !== "string" || !APPLE_EVENT_TOOLS.has(name)) return false;
  const pid = targetPid(isRecord(args) ? args : undefined);
  return pid === undefined || !listed.has(pid);
};

const CODES: ReadonlyMap<string, ComputerUseRefusalDetail> = new Map([
  ["automation_denied", "automation_not_allowed"],
  ["automation_timeout", "automation_pending"],
]);

/**
 * invoke_menu's background save folds the Apple Events cause into its refusal message as
 * "... did not complete (<code>: <reason>)"; only the code right after that wrapper counts, so a
 * file name inside another code's reason cannot pass for one.
 */
const SAVE_CAUSE = /scripting interface did not complete \((automation_[a-z]+): /u;

function automationDetail(
  structured: Record<string, unknown>,
): ComputerUseRefusalDetail | undefined {
  const nested = isRecord(structured.refusal) ? structured.refusal : {};
  for (const code of [structured.code, structured.cause, nested.code]) {
    const detail = typeof code === "string" ? CODES.get(code) : undefined;
    if (detail !== undefined) return detail;
  }
  if (structured.code !== "background_unavailable" || typeof nested.message !== "string")
    return undefined;
  const cause = SAVE_CAUSE.exec(nested.message)?.[1];
  return cause === undefined ? undefined : CODES.get(cause);
}

const note = (detail: ComputerUseRefusalDetail, block: CuaAgentPermissionsBlock) =>
  detail === "automation_not_allowed"
    ? `GOAT: ${cuaAgentBlockMessage(block)} Tell the person which app it is, and do not try this route again until they say they have allowed it.`
    : `GOAT: ${block.target ?? "The app"} did not answer the Apple Events in time; macOS may be showing its Automation prompt for ${block.holder === "helper" ? "GOAT Computer Use" : "GOAT"} on this Mac. Ask the person to answer it, observe the window, then try once more.`;

/**
 * The driver's reply to a tools/call, with GOAT's typed refusal added when the driver refused it
 * for Automation consent. holder is the app macOS asks on this host's behalf; without one (not
 * macOS) the line passes unchanged. No app means the proxy could not name the pid's bundle id.
 */
export function typeAutomationRefusal(
  line: string,
  holder: "helper" | "app" | undefined,
  callArgs: unknown,
  listed: ReadonlyMap<number, { readonly bundleId?: string }>,
): string {
  if (holder === undefined) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(message) || !isRecord(message.result)) return line;
  const result = message.result;
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  // Only a reply the driver itself marks refused; an explicit other effect wins over a status.
  if (
    result.isError !== true ||
    structured === undefined ||
    (structured.effect === undefined
      ? structured.status !== "refused"
      : structured.effect !== "refused")
  )
    return line;
  const detail = automationDetail(structured);
  if (detail === undefined) return line;
  const pid = targetPid(isRecord(callArgs) ? callArgs : undefined) ?? targetPid(structured);
  const target = pid === undefined ? undefined : listed.get(pid)?.bundleId;
  const block: CuaAgentPermissionsBlock = {
    reason: "permissionsNotGranted",
    missing: ["automation"],
    holder,
    ...(target === undefined ? {} : { target }),
  };
  const content = Array.isArray(result.content) ? result.content : [];
  return JSON.stringify({
    ...message,
    result: {
      ...result,
      content: [...content, { type: "text", text: note(detail, block) }],
      structuredContent: {
        ...structured,
        refused: computerUseRefusalReason(detail),
        detail,
        ...(target === undefined ? {} : { app: target }),
        block,
      },
    },
  });
}
