import type { Permission } from "@opencode/client/effect";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export type Rule = Permission.Rule;
export type RulesPolicy = Pick<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  "runtimeMode" | "interactionMode"
>;

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

/**
 * The last matching rule wins: every GOAT server is denied, then this thread's own allowed. All Cua
 * Drivers are denied, even under full access's `* allow`, and only a turn with one allows its own.
 */
const mcpRules = (
  names: { readonly goat: string; readonly cua: string | null } | null,
): ReadonlyArray<Rule> =>
  names === null
    ? [rule(`${McpProviderSession.CUA_MCP_SERVER_NAME}-*`, "deny")]
    : [
        // A reused daemon can still carry registrations from before the rename.
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: "goat-*", resource: "*", effect: "deny" },
        { action: `${names.goat}_*`, resource: "*", effect: "allow" },
        rule(`${McpProviderSession.CUA_MCP_SERVER_NAME}-*`, "deny"),
        ...(names.cua === null ? [] : [rule(`${names.cua}_*`, "allow")]),
      ];

export const sessionRules = (
  policy: RulesPolicy,
  paths: ReadonlyArray<Rule>,
  grants: ReadonlyArray<Rule>,
  mcpServerNames: { readonly goat: string; readonly cua: string | null } | null,
  subagentsOff: boolean,
): ReadonlyArray<Rule> => [
  ...(policy.runtimeMode === "full-access"
    ? [rule("*", "allow")]
    : [
        rule("shell", "ask"),
        rule("edit", policy.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
        rule("external_directory", "ask"),
      ]),
  ...grants,
  // Plan edits are re-allowed only for plan paths; free-tier sessions refuse denied shell/read.
  ...(policy.interactionMode === "plan" ? [rule("edit", "deny")] : []),
  ...paths,
  ...mcpRules(mcpServerNames),
  // OpenCode checks this before every launch but has no concurrency cap: a goatclaw limit of
  // zero denies subagents last so no grant can reopen them, and other limits leave them uncapped.
  ...(subagentsOff ? [rule("subagent", "deny")] : []),
];

export const deniesSubagents = (rules: ReadonlyArray<Rule> | undefined) =>
  rules?.some((entry) => entry.action === "subagent" && entry.effect === "deny") === true;

export const sameRules = (left: ReadonlyArray<Rule> | undefined, right: ReadonlyArray<Rule>) =>
  left?.length === right.length &&
  left.every(
    (entry, index) =>
      entry.action === right[index]?.action &&
      entry.resource === right[index]?.resource &&
      entry.effect === right[index]?.effect,
  );
