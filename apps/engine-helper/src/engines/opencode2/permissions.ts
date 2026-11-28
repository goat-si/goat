import { createHash } from "node:crypto";
import type { RequestOutcome, RuntimeMode } from "@goat2/contracts-rs";
import type { PermissionRequest, PermissionRule, PermissionReplyInput } from "@opencode/client";
import { HelperError } from "../../protocol.ts";

// Adapted from v2/sessionRules.ts and v2/mcpNames.ts at 916b5ccc1b.
export type Rule = PermissionRule;
export type RulesPolicy = { runtimeMode: RuntimeMode; interactionMode?: "plan" | "default" };
export type McpServerNames = { readonly goat: string; readonly cua: string | null };
// permissionRules.ts:12-44: classify by native permission or the tool that requested it.
export function permissionKind(action: string, tool?: string): "file-change" | "file-read" | "command" {
  const value = action.toLowerCase(), name = tool?.toLowerCase() ?? "";
  if (["edit", "write", "patch", "apply_patch"].includes(value) || ["edit", "write", "patch", "apply_patch"].includes(name)) return "file-change";
  if (["read", "glob", "grep", "lsp", "external_directory"].includes(value) || name === "read" || name.includes("glob") || name.includes("grep") || name.includes("search")) return "file-read";
  return "command";
}
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });
const digest = (threadId: string) => createHash("sha256").update(threadId).digest("hex").slice(0, 16);
export const goatMcpServerName = (threadId: string): string => {
  const sanitized = threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized === threadId && sanitized.length <= 56 ? `goat-${sanitized}` : `goat-${digest(threadId)}`;
};
export const cuaMcpServerName = (threadId: string): string => `cua-driver-${digest(threadId)}`;

export function sessionRules(policy: RulesPolicy, paths: ReadonlyArray<Rule>, grants: ReadonlyArray<Rule>, names: McpServerNames | null, subagentsOff: boolean): Rule[] {
  return [
    ...(policy.runtimeMode === "full-access" ? [rule("*", "allow")] : [rule("shell", "ask"), rule("edit", policy.runtimeMode === "auto-accept-edits" ? "allow" : "ask"), rule("external_directory", "ask")]),
    ...grants,
    ...(policy.interactionMode === "plan" ? [rule("edit", "deny")] : []),
    ...paths,
    ...(names === null ? [rule("cua-driver-*", "deny")] : [rule("t3-code-*", "deny"), rule("goat-*", "deny"), rule(`${names.goat}_*`, "allow"), rule("cua-driver-*", "deny"), ...(names.cua === null ? [] : [rule(`${names.cua}_*`, "allow")])]),
    ...(subagentsOff ? [rule("subagent", "deny")] : []),
  ];
}

export const deniesSubagents = (rules: ReadonlyArray<Rule> | undefined): boolean => rules?.some((entry) => entry.action === "subagent" && entry.effect === "deny") === true;
export const sameRules = (left: ReadonlyArray<Rule> | undefined, right: ReadonlyArray<Rule>): boolean =>
  left?.length === right.length && left.every((entry, index) => entry.action === right[index]?.action && entry.resource === right[index]?.resource && entry.effect === right[index]?.effect);

// v1 stores grants on the asking session and always answers the native request once.
export function permissionReply(request: PermissionRequest, outcome: RequestOutcome, grants: ReadonlyArray<Rule>): { reply: PermissionReplyInput; grants: Rule[] } {
  if (!["accept", "acceptForSession", "acceptAlways", "decline", "cancel"].includes(outcome)) throw new HelperError("bad_request", "OpenCode permission requires an approval decision");
  const approved = outcome === "accept" || outcome === "acceptForSession" || outcome === "acceptAlways";
  const next = [...grants];
  if (outcome === "acceptForSession" || outcome === "acceptAlways") {
    for (const resource of request.save ?? []) {
      if (!next.some((entry) => entry.action === request.action && entry.resource === resource)) next.push({ action: request.action, resource, effect: "allow" });
    }
  }
  return { reply: { sessionID: request.sessionID, requestID: request.id, decision: approved ? "once" : "reject", ...(outcome === "decline" ? { message: "The user declined this request." } : {}) }, grants: next };
}
