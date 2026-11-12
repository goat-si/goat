import {
  AuthHubProxyScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  hubProxyAdmitsMethod,
  RpcScopeAuthorization,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type SessionPrincipalKind,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import { makeInFlightLimit } from "./RpcInFlightLimit.ts";
import type { SessionStore } from "./SessionStore.ts";

export const hubProxyRefusal = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthHubProxyScope });

/**
 * A node hands any stored attachment it is given to the provider, whichever thread stored it. A
 * proxied follow-up, launch or answer may therefore carry only fresh uploads or the destination
 * thread's own files.
 */
const attachmentsBelongToThread = (threadId: unknown, attachments: ReadonlyArray<unknown>) => {
  const own = typeof threadId === "string" ? toSafeThreadAttachmentSegment(threadId) : null;
  return attachments.every((attachment) => {
    const id = (attachment as { readonly id?: unknown } | null)?.id;
    if (typeof id !== "string") return false;
    const segment = parseThreadSegmentFromAttachmentId(id);
    return segment === PENDING_ATTACHMENT_THREAD_SEGMENT || (own !== null && segment === own);
  });
};

const asArray = (value: unknown): ReadonlyArray<unknown> | undefined =>
  Array.isArray(value) ? value : undefined;

/** False when a call that can carry attachments carries one the destination thread does not own. */
const attachmentsAreOwned = (method: string, payload: unknown): boolean => {
  const call = payload as Record<string, unknown>;
  if (method === "orchestration.launchThread") {
    const initial = call["initialMessage"] as { readonly attachments?: unknown } | undefined;
    if (initial === undefined) return true;
    const attachments = asArray(initial?.attachments);
    return attachments !== undefined && attachmentsBelongToThread(call["threadId"], attachments);
  }
  if (method !== "orchestration.dispatchCommand") return true;
  if (call["type"] === "message.dispatch") {
    const attachments = asArray(call["attachments"]);
    return attachments !== undefined && attachmentsBelongToThread(call["threadId"], attachments);
  }
  if (call["type"] === "runtime-request.respond") {
    const byQuestion = call["attachmentsByQuestionId"];
    if (byQuestion === undefined) return true;
    if (typeof byQuestion !== "object" || byQuestion === null) return false;
    const lists = Object.values(byQuestion).map(asArray);
    return lists.every(
      (attachments) =>
        attachments !== undefined && attachmentsBelongToThread(call["threadId"], attachments),
    );
  }
  return true;
};

/** Why the hub will not forward this call, or undefined when it will. */
export const refuseProxiedCall = (
  effective: ReadonlyArray<AuthEnvironmentScope>,
  method: string,
  payload: unknown,
): EnvironmentAuthorizationError | undefined => {
  let required: ReadonlyArray<AuthEnvironmentScope>;
  try {
    required = RpcAuthorization.requiredScopesForRpcCall(method, payload);
  } catch {
    // An unknown method or an undecodable payload: the hub cannot tell what it would do.
    return hubProxyRefusal(`${method} is not available through the hub.`);
  }
  const missing = required.find((scope) => !effective.includes(scope));
  if (missing !== undefined) return RpcAuthorization.rpcAuthorizationError(missing);
  if (!hubProxyAdmitsMethod(method, payload, required))
    return hubProxyRefusal(`${method} is not available through the hub.`);
  if (!attachmentsAreOwned(method, payload))
    return hubProxyRefusal("Attachments from another thread cannot be sent through the hub.");
  return undefined;
};

/**
 * RPC authorization for one socket's session. A Pen member proxy's every call also passes the hub
 * proxy's frame policy, judged on the session's current scopes, so a revocation or narrowing
 * applies on the next frame (mesh link design §5); other sessions keep the plain scope check.
 */
export const layerFor = (
  session: {
    readonly sessionId: AuthSessionId;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly principalKind?: SessionPrincipalKind | undefined;
  },
  sessions: Pick<SessionStore["Service"], "readActiveScopes">,
  onAuthorized?: (method: string, payload: unknown) => Effect.Effect<void>,
  maxInFlight?: number,
) =>
  session.principalKind !== "proxied_person"
    ? RpcAuthorization.layer(session.scopes, onAuthorized, maxInFlight)
    : Layer.sync(RpcScopeAuthorization)(() => {
        const limitInFlight = makeInFlightLimit(maxInFlight);
        return (effect, { rpc, payload }) =>
          sessions.readActiveScopes(session.sessionId).pipe(
            Effect.mapError(() =>
              RpcAuthorization.rpcAuthorizationError(AuthOrchestrationReadScope),
            ),
            Effect.flatMap((scopes) => {
              const refusal = refuseProxiedCall(scopes, rpc._tag, payload);
              return refusal === undefined ? Effect.void : Effect.fail(refusal);
            }),
            Effect.andThen(
              limitInFlight(
                rpc,
                onAuthorized === undefined
                  ? effect
                  : Effect.tap(effect, () => onAuthorized(rpc._tag, payload)),
              ),
            ),
          );
      });
