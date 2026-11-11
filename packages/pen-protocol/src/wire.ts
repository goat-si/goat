export const FrameType = { Open: 1, Data: 2, Close: 3 } as const;

export const CloseCode = {
  Normal: 1000,
  Unsupported: 1003,
  TooBig: 1009,
  Crypto: 4400,
  NotAdmitted: 4401,
  Protocol: 4402,
  AuthFailed: 4403,
  Offline: 4404,
  Timeout: 4408,
  Replaced: 4409,
  Caps: 4429,
} as const;

export const Limits = {
  MESSAGE_MAX: 1024 * 1024,
  SOCKET_WINDOW: 4 * 1024 * 1024,
  /** Unacked DATA a session may hold on the uplink and still count as light. */
  LIGHT_SESSION: 16 * 1024,
  /** Extra uplink window for the relay's own OPEN and CLOSE frames. */
  RELAY_HEADROOM: 64 * 1024,
  ACK_STEP: 64 * 1024,
  PENDING_MAX: 8,
  ACTIVE_MAX: 32,
  CHALLENGE_LEN: 32,
  FRAME_HEADER: 5,
  AUTH_ANSWER_LEN: 96,
} as const;

export const Timeouts = {
  AUTH_TIMEOUT_MS: 10_000,
  PENDING_TIMEOUT_MS: 10_000,
  IDLE_TIMEOUT_MS: 90_000,
} as const;

export interface Frame {
  readonly type: number;
  readonly sid: number;
  readonly payload: Uint8Array;
}

/** `[type u8][sid u32 LE][payload]` */
export function encodeFrame(
  type: number,
  sid: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Limits.FRAME_HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, sid, true);
  out.set(payload, Limits.FRAME_HEADER);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < Limits.FRAME_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint8(0),
    sid: view.getUint32(1, true),
    payload: bytes.subarray(Limits.FRAME_HEADER),
  };
}

export function closePayload(code: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, code, true);
  return out;
}

export function readClose(payload: Uint8Array): number | null {
  if (payload.length !== 2) return null;
  return new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, true);
}

const encoder = new TextEncoder();

/** The bytes a node signs: `"pen-relay-v1" || relayOrigin || nodeId || challenge`. */
export function challengeMessage(
  relayOrigin: string,
  nodeId: string,
  challenge: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const parts = [
    encoder.encode("pen-relay-v1"),
    encoder.encode(relayOrigin),
    encoder.encode(nodeId),
    challenge,
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `wss://` or `ws://` plus the WHATWG URL host of the URL the node dialed. */
export function relayOrigin(url: string): string {
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  return (secure ? "wss://" : "ws://") + parsed.host;
}

/** Cumulative ack text `a:<n>`; decimal digits only, no sign or leading zeros. */
export function parseAck(text: string): number | null {
  const match = /^a:(0|[1-9][0-9]{0,15})$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}
