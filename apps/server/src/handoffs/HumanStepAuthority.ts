/**
 * Who may resolve a step that needs a person (docs/internals/agent-surface.md, Human steps). A
 * stored session is classified by the principal kind written at issue; one without it is no person.
 * @module HumanStepAuthority
 */
import type { SessionPrincipalKind } from "@goat/contracts";

export type HumanStepResolver =
  | { readonly kind: "person" }
  | { readonly kind: "outside_client"; readonly approvals: boolean }
  | { readonly kind: "proxied_person" }
  | { readonly kind: "thread" };

export type HumanStep = "runtime_approval" | "person_only";

export const PERSON: HumanStepResolver = { kind: "person" };

/** A thread scope wins over any client fields it also carries. */
export const mcpResolver = (scope: McpInvocationScope): HumanStepResolver =>
  scope.thread !== undefined
    ? { kind: "thread" }
    : { kind: "outside_client", approvals: scope.client?.approvals === true };

/** A stored client session, by the principal kind written at issue (mesh link design §5). */
export const sessionResolver = (session: {
  readonly principalKind?: SessionPrincipalKind | undefined;
}): HumanStepResolver =>
  session.principalKind === "person"
    ? PERSON
    : session.principalKind === "proxied_person"
      ? { kind: "proxied_person" }
      : { kind: "outside_client", approvals: false };

export const canResolveHumanStep = (resolver: HumanStepResolver, step: HumanStep) =>
  resolver.kind === "person" ||
  (step === "runtime_approval" &&
    (resolver.kind === "proxied_person" ||
      (resolver.kind === "outside_client" && resolver.approvals)));
