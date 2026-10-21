import {
  AuthHubProxyScope,
  EnvironmentAuthorizationError,
  hubProxyAdmitsMethod,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

import { requiredScopesForRpcCall, rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

/**
 * Client frames on a proxied socket are Effect RPC JSON: one envelope or an array of them per
 * WebSocket message. Only `Request` names a method, so it is the only envelope the hub judges.
 * Ack and Interrupt can only name ids on this client's own upstream socket (there is no pooling),
 * so they pass through, as do Ping and Eof.
 */
type Envelope = {
  readonly _tag?: unknown;
  readonly id?: unknown;
  readonly tag?: unknown;
  readonly payload?: unknown;
};

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
    required = requiredScopesForRpcCall(method, payload);
  } catch {
    // An unknown method or an undecodable payload: the hub cannot tell what it would do.
    return hubProxyRefusal(`${method} is not available through the hub.`);
  }
  const missing = required.find((scope) => !effective.includes(scope));
  if (missing !== undefined) return rpcAuthorizationError(missing);
  if (!hubProxyAdmitsMethod(method, payload, required))
    return hubProxyRefusal(`${method} is not available through the hub.`);
  if (!attachmentsAreOwned(method, payload))
    return hubProxyRefusal("Attachments from another thread cannot be sent through the hub.");
  return undefined;
};

const encodeAuthorizationError = Schema.encodeSync(EnvironmentAuthorizationError);

/** An Effect RPC failure Exit for one request, keeping the client's id and its type. */
const refusalExit = (id: string | number, error: EnvironmentAuthorizationError) => ({
  _tag: "Exit",
  requestId: id,
  exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: encodeAuthorizationError(error) }] },
});

export interface GatedFrame {
  /** What to send upstream: the original frame when nothing was refused, otherwise the rest. */
  readonly forward: string | Uint8Array | undefined;
  /** Messages to send back to the client, one per refused request. */
  readonly replies: ReadonlyArray<string>;
}

const textDecoder = new TextDecoder();

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Judges one client WebSocket message. A message the hub cannot parse is dropped: the node
 * would only answer it with a protocol defect, and forwarding it would skip the checks.
 */
export const gateClientFrame = (
  frame: string | Uint8Array,
  admit: (method: string, payload: unknown) => EnvironmentAuthorizationError | undefined,
): GatedFrame => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof frame === "string" ? frame : textDecoder.decode(frame));
  } catch {
    return { forward: undefined, replies: [] };
  }
  const batch = Array.isArray(parsed);
  const envelopes: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed];
  const kept: Array<unknown> = [];
  const replies: Array<string> = [];
  for (const envelope of envelopes) {
    if (!isEnvelope(envelope)) continue;
    if (envelope._tag !== "Request") {
      kept.push(envelope);
      continue;
    }
    const id = envelope.id;
    if ((typeof id !== "string" && typeof id !== "number") || typeof envelope.tag !== "string")
      continue;
    const refused = admit(envelope.tag, envelope.payload);
    if (refused === undefined) kept.push(envelope);
    else replies.push(JSON.stringify(refusalExit(id, refused)));
  }
  if (kept.length === envelopes.length) return { forward: frame, replies };
  if (kept.length === 0) return { forward: undefined, replies };
  return { forward: JSON.stringify(batch ? kept : kept[0]), replies };
};
