import type { SessionPrincipalKind } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { AuthSessionPenBinding } from "../persistence/AuthSessions.ts";
import type { ConnectionContext } from "./connectionContext.ts";
import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";
import { SessionBindingRefusedError } from "./sessionStoreErrors.ts";

/** Subject of a member proxy session (mesh link design §5); never a person. */
export const PEN_PROXY_SUBJECT = "pen-proxy";
export const PEN_SESSION_MAX_TTL = Duration.hours(12);

/** The kind a new session gets when its issuer does not name one. */
export const defaultPrincipalKind = (subject: string): SessionPrincipalKind =>
  subject === MCP_CLIENT_SUBJECT ? "outside_client" : "person";

/** Why a requested session shape is refused, or undefined when it is valid. */
export const issueShapeRefusal = (
  subject: string,
  kind: SessionPrincipalKind,
  binding: AuthSessionPenBinding | undefined,
): string | undefined => {
  if ((subject === PEN_PROXY_SUBJECT) !== (kind === "proxied_person"))
    return "Only pen-proxy sessions are proxied_person.";
  if (kind === "proxied_person" && binding === undefined)
    return "A proxied_person session needs a Pen binding.";
  if (binding !== undefined && kind === "person") return "A person session has no Pen binding.";
  if (binding !== undefined && kind === "outside_client" && subject !== MCP_CLIENT_SUBJECT)
    return "A Pen-bound outside_client session is an mcp-client session.";
  return undefined;
};

/**
 * The one binding check every verifier ends in (mesh link design §6). A Pen-bound session passes
 * only on a live Pen connection whose proven peer matches every binding field; an unbound session
 * passes only on the main listener. Anything else, including a missing context, fails.
 */
export const admitBinding = (
  session: { readonly sessionId: string; readonly penBinding?: AuthSessionPenBinding },
  connection: ConnectionContext | undefined,
): Effect.Effect<void, SessionBindingRefusedError> => {
  const reason = bindingRefusal(session.penBinding, connection);
  return reason === undefined
    ? Effect.void
    : Effect.fail(new SessionBindingRefusedError({ sessionId: session.sessionId, reason }));
};

const bindingRefusal = (
  binding: AuthSessionPenBinding | undefined,
  connection: ConnectionContext | undefined,
): SessionBindingRefusedError["reason"] | undefined => {
  if (connection === undefined) return "no_connection";
  if (binding === undefined) return connection.kind === "main" ? undefined : "wrong_listener";
  if (connection.kind !== "pen") return "wrong_listener";
  if (!connection.alive()) return "connection_closed";
  const peer = connection.peer;
  return peer.meshId === binding.meshId &&
    peer.nodeId === binding.nodeId &&
    peer.signPub === binding.signPub &&
    peer.noisePub === binding.noisePub
    ? undefined
    : "peer_mismatch";
};
