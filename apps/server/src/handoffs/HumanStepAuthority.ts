/**
 * Who may resolve a step that needs a person (docs/internals/agent-surface.md, Human steps):
 * a runtime approval may be resolved by a person's client session or by an outside MCP client
 * a person minted with orchestration:operate and orchestration:approve; every other human step
 * only by a person's client session; a thread credential resolves none, whatever its scopes.
 * Resolvers are built from authenticated server context, never from tool input.
 *
 * @module HumanStepAuthority
 */
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { MCP_CLIENT_SUBJECT } from "../auth/mcpClientSubject.ts";

export type HumanStepResolver =
  | { readonly kind: "person" }
  | { readonly kind: "outside_client"; readonly approvals: boolean }
  | { readonly kind: "thread" };

export type HumanStep = "runtime_approval" | "person_only";

export const PERSON: HumanStepResolver = { kind: "person" };

/** A thread scope wins over any client fields it also carries. */
export const mcpResolver = (scope: McpInvocationScope): HumanStepResolver =>
  scope.thread !== undefined
    ? { kind: "thread" }
    : { kind: "outside_client", approvals: scope.client?.approvals === true };

/**
 * A stored client session. MCP client sessions are refused outside /mcp, so this only guards a
 * caller that passes one in; every other subject, desktop-bootstrap included, is a person's client.
 */
export const sessionResolver = (session: { readonly subject: string }): HumanStepResolver =>
  session.subject === MCP_CLIENT_SUBJECT ? { kind: "outside_client", approvals: false } : PERSON;

export const canResolveHumanStep = (resolver: HumanStepResolver, step: HumanStep) =>
  resolver.kind === "person" ||
  (step === "runtime_approval" && resolver.kind === "outside_client" && resolver.approvals);
