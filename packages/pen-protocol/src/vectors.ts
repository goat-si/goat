import {
  fingerprint,
  nodeIdFromSignPub,
  signingKeyFromSeed,
  toHex,
  x25519PublicKey,
} from "./identity.ts";
import {
  challengeMessage,
  closePayload,
  CloseCode,
  encodeFrame,
  FrameType,
  parseAck,
  relayOrigin,
} from "./wire.ts";

// Byte fields are lowercase hex. Seeds are 32 repeated bytes.
export const SIGN_SEED = new Uint8Array(32).fill(0x01);
export const NOISE_PRIV = new Uint8Array(32).fill(0x02);
const CHALLENGE = Uint8Array.from({ length: 32 }, (_, i) => i);
const RELAY_URL = "wss://pen-relay.example.workers.dev/v1/node/";

export async function buildIdentityVector() {
  const key = await signingKeyFromSeed(SIGN_SEED);
  const noisePub = await x25519PublicKey(NOISE_PRIV);
  return {
    encoding: "hex",
    signSeed: toHex(SIGN_SEED),
    signPub: toHex(key.signPub),
    nodeId: await nodeIdFromSignPub(key.signPub),
    noisePriv: toHex(NOISE_PRIV),
    noisePub: toHex(noisePub),
    fingerprint: await fingerprint(noisePub),
  };
}

export async function buildRelayVector() {
  const key = await signingKeyFromSeed(SIGN_SEED);
  const nodeId = await nodeIdFromSignPub(key.signPub);
  const origin = relayOrigin(RELAY_URL + nodeId);
  const message = challengeMessage(origin, nodeId, CHALLENGE);
  const frame = (type: number, sid: number, payload: Uint8Array) => ({
    type,
    sid,
    payload: toHex(payload),
    hex: toHex(encodeFrame(type, sid, payload)),
  });
  return {
    encoding: "hex",
    signSeed: toHex(SIGN_SEED),
    nodeId,
    relayOrigin: origin,
    challenge: toHex(CHALLENGE),
    challengeMessage: toHex(message),
    signature: toHex(await key.sign(message)),
    // What the node sends after the challenge: signPub (32) || signature (64).
    answer: toHex(new Uint8Array([...key.signPub, ...(await key.sign(message))])),
    origins: [
      "wss://Pen-Relay.Example.workers.dev:443/v1/node/x",
      "wss://pen-relay.example.workers.dev:8443/v1/node/x",
      "ws://127.0.0.1:8787/v1/node/x",
      "ws://localhost:80/v1/node/x",
      "https://pen-relay.example.workers.dev/v1/node/x",
    ].map((url) => ({ url, origin: relayOrigin(url) })),
    frames: [
      frame(FrameType.Open, 1, new Uint8Array(0)),
      frame(FrameType.Data, 2, new TextEncoder().encode("hello pen")),
      frame(FrameType.Close, 3, closePayload(CloseCode.Offline)),
      frame(FrameType.Data, 0xffffffff, Uint8Array.of(0x00, 0xff)),
    ],
    acks: [
      "a:0",
      "a:65536",
      "a:9007199254740991",
      "a:",
      "a:-1",
      "a:01",
      "a:1.5",
      "a: 1",
      "b:1",
      "a:1e3",
      "a:9007199254740992",
    ].map((text) => ({ text, value: parseAck(text) })),
  };
}
