import * as Schema from "effect/Schema";

import {
  AuthFilesystemReadScope,
  AuthHubProxyScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthEnvironmentScopes,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ShellSnapshot } from "./orchestrationV2.ts";

/**
 * A client paired only to a hub reaches a node's own HTTP and WebSocket API below
 * `/hub/nodes/<nodeId>/`. The hub authenticates the client, holds the node session itself and
 * forwards only what the policy below admits, so node credentials never reach the client.
 */
export const HUB_PROXY_ROUTE_PREFIX = "/hub/nodes";

export const hubProxyNodePath = (nodeId: string): string =>
  `${HUB_PROXY_ROUTE_PREFIX}/${encodeURIComponent(nodeId)}`;

export const HubProxyNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
export type HubProxyNodeId = typeof HubProxyNodeId.Type;

/**
 * The most a hub ever asks of a node for a proxied client. A client's rights on a node are its
 * own hub scopes intersected with this, so widening it is the one switch for new proxied actions.
 */
export const HUB_PROXY_NODE_SCOPE_CEILING: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  // The folder chooser for a new thread on the node.
  AuthFilesystemReadScope,
];

/** The client's rights on a node: none without `hub:proxy`, otherwise its scopes within the ceiling. */
export const hubProxyEffectiveScopes = (
  clientScopes: ReadonlyArray<AuthEnvironmentScope>,
  limit: ReadonlyArray<AuthEnvironmentScope> = HUB_PROXY_NODE_SCOPE_CEILING,
): ReadonlyArray<AuthEnvironmentScope> =>
  clientScopes.includes(AuthHubProxyScope)
    ? limit.filter((scope, index) => clientScopes.includes(scope) && limit.indexOf(scope) === index)
    : [];

/**
 * Read-only calls pass on their scope alone. Anything that needs more must be listed here with a
 * payload check, because one scope (`orchestration:operate`) covers far more than the hub offers.
 */
const HUB_PROXY_METHOD_POLICY: Readonly<Record<string, (payload: unknown) => boolean>> = {
  "orchestration.dispatchCommand": (payload) => hubProxyAdmitsCommand(payload),
  // Image and file follow-ups: the node mints a signed upload URL the hub forwards bytes to.
  "attachments.createUploadUrl": () => true,
  "attachments.delete": () => true,
  // A new thread on the node, in a project that exists or one made from a chosen folder.
  "orchestration.launchThread": () => true,
  "filesystem.browse": () => true,
  "projects.mutate": (payload) => hubProxyAdmitsProjectMutation(payload),
};

/** Orchestration commands a client may send to a node through the hub. */
export const HUB_PROXY_COMMAND_TYPES: ReadonlySet<string> = new Set([
  // A follow-up in an existing thread, with any attachments uploaded through the hub.
  "message.dispatch",
  // The stop button, which holds the queue, and resuming that queue afterwards.
  "run.interrupt",
  "queue.resume",
  // Answers to a provider's approval request or question, and dismissing a question.
  "runtime-request.respond",
  "thread.user-input.dismiss",
  // A new thread record, as "implement in a new thread" and side chats create.
  "thread.create",
]);

const hubProxyAdmitsCommand = (payload: unknown): boolean => {
  if (typeof payload !== "object" || payload === null) return false;
  const command = payload as { readonly type?: unknown };
  if (typeof command.type !== "string" || !HUB_PROXY_COMMAND_TYPES.has(command.type)) return false;
  return command.type !== "message.dispatch" || hubProxyAdmitsFollowUp(payload);
};

/**
 * What an interactive client puts in a follow-up: its text, context and attachments, the model it
 * chose in the composer, the plan it implements, and how to deliver it. Fields only automation
 * sends (scheduled tasks, notifications, delegated completion, usage-limit recovery) are refused,
 * as is a deferred start that prepares a workspace.
 */
const HUB_PROXY_FOLLOW_UP_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "commandId",
  "threadId",
  "messageId",
  "text",
  "context",
  "attachments",
  "titleSeed",
  "modelSelection",
  "sourcePlanRef",
  "manualContinuationOfRunId",
  "deliveryIntent",
  "dispatchMode",
  "createdBy",
  "creationSource",
  "memoryGrantCeiling",
]);

const hubProxyAdmitsFollowUp = (payload: object): boolean => {
  const message = payload as {
    readonly createdBy?: unknown;
    readonly dispatchMode?: { readonly type?: unknown };
    readonly memoryGrantCeiling?: unknown;
  };
  return (
    Object.keys(payload).every((key) => HUB_PROXY_FOLLOW_UP_FIELDS.has(key)) &&
    message.createdBy === "user" &&
    message.dispatchMode?.type !== "defer_start" &&
    (message.memoryGrantCeiling === undefined || message.memoryGrantCeiling === "none")
  );
};

/**
 * Only registering an existing folder as a project. Scripts need settings:write, and creating the
 * folder would let the chooser write to the node's filesystem.
 */
const hubProxyAdmitsProjectMutation = (payload: unknown): boolean => {
  if (typeof payload !== "object" || payload === null) return false;
  const mutation = payload as {
    readonly type?: unknown;
    readonly scripts?: unknown;
    readonly createWorkspaceRootIfMissing?: unknown;
  };
  return (
    mutation.type === "project.create" &&
    mutation.scripts === undefined &&
    mutation.createWorkspaceRootIfMissing !== true
  );
};

/** Whether the hub forwards a call that already passed the scope check for these required scopes. */
export const hubProxyAdmitsMethod = (
  method: string,
  payload: unknown,
  requiredScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => {
  if (requiredScopes.every((scope) => scope === AuthOrchestrationReadScope)) return true;
  const admits = Object.hasOwn(HUB_PROXY_METHOD_POLICY, method)
    ? HUB_PROXY_METHOD_POLICY[method]
    : undefined;
  return admits !== undefined && admits(payload);
};

/**
 * Client-side mirror of the hub's policy, for hiding actions on a node reached through a hub.
 * Clients only know the guarded scopes, so a call they cannot classify stays visible and the hub
 * still refuses it if it must.
 */
export const hubProxyHidesClientCall = (
  method: string,
  payload: unknown,
  guardedScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => {
  if (Object.hasOwn(HUB_PROXY_METHOD_POLICY, method))
    return !HUB_PROXY_METHOD_POLICY[method]!(payload);
  return guardedScopes.some((scope) => scope !== AuthOrchestrationReadScope);
};

/** The hub's last copy of a node's shell, served while the node is unreachable. */
export const HubProxySnapshot = Schema.Struct({
  nodeId: HubProxyNodeId,
  capturedAt: IsoDateTime,
  shell: OrchestrationV2ShellSnapshot,
});
export type HubProxySnapshot = typeof HubProxySnapshot.Type;

/** Body of a 503 from a proxied path when the hub cannot reach the node. */
export const HubProxyUnavailable = Schema.Struct({
  code: Schema.Literal("hub_node_unavailable"),
  message: Schema.String,
});
export type HubProxyUnavailable = typeof HubProxyUnavailable.Type;

export const HubProxyNodeInput = Schema.Struct({ nodeId: HubProxyNodeId });
export type HubProxyNodeInput = typeof HubProxyNodeInput.Type;

/** Lets the hub open client sessions on a linked node, by spending a pairing link that node issued. */
export const HubProxyEnrollInput = Schema.Struct({
  nodeId: HubProxyNodeId,
  pairingUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type HubProxyEnrollInput = typeof HubProxyEnrollInput.Type;
export const HubProxyEnrollResult = Schema.Struct({ scopes: AuthEnvironmentScopes });
export type HubProxyEnrollResult = typeof HubProxyEnrollResult.Type;
export const HubProxyUnenrollResult = Schema.Struct({ removed: Schema.Boolean });
export type HubProxyUnenrollResult = typeof HubProxyUnenrollResult.Type;

/** Safe to show: never carries a token or a raw node response. */
export class HubProxyRpcError extends Schema.TaggedError<HubProxyRpcError>()("HubProxyRpcError", {
  reason: Schema.Literals(["not_found", "unavailable", "enrollment_required", "refused"]),
  detail: Schema.String.check(Schema.isMaxLength(2000)),
}) {
  override get message(): string {
    return this.detail;
  }
}
