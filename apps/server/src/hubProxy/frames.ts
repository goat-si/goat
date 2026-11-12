import { EnvironmentAuthorizationError } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { hubProxyRefusal, refuseProxiedCall } from "../auth/proxiedCallPolicy.ts";

export { hubProxyRefusal, refuseProxiedCall };

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
