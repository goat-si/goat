import { describe, expect, it } from "vite-plus/test";
import relay from "../vectors/relay.json" with { type: "json" };
import { fromHex, nodeIdFromSignPub, toHex } from "./identity.ts";
import { buildRelayVector } from "./vectors.ts";
import { challengeMessage, decodeFrame, encodeFrame, readClose } from "./wire.ts";

describe("relay vectors (CONTRACT Relay)", () => {
  it("challenge message, signature, origins, frames and acks recomputed match vectors/relay.json", async () => {
    expect(await buildRelayVector()).toEqual(relay);
  });

  it("the uplink answer verifies over pen-relay-v1 || relayOrigin || nodeId || challenge", async () => {
    const answer = fromHex(relay.answer);
    const signPub = answer.slice(0, 32);
    const signature = answer.slice(32);
    expect(await nodeIdFromSignPub(signPub)).toBe(relay.nodeId);
    const message = challengeMessage(relay.relayOrigin, relay.nodeId, fromHex(relay.challenge));
    expect(toHex(message)).toBe(relay.challengeMessage);
    const key = await crypto.subtle.importKey("raw", signPub, "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", key, signature, message)).toBe(true);
    const tampered = Uint8Array.from(message);
    tampered.set([0x00], 0);
    expect(await crypto.subtle.verify("Ed25519", key, signature, tampered)).toBe(false);
  });

  it("mux frames decode to their type, little-endian sid and payload", () => {
    for (const frame of relay.frames) {
      const decoded = decodeFrame(fromHex(frame.hex));
      expect(decoded).not.toBeNull();
      expect({
        type: decoded?.type,
        sid: decoded?.sid,
        payload: toHex(decoded?.payload ?? new Uint8Array()),
      }).toEqual({
        type: frame.type,
        sid: frame.sid,
        payload: frame.payload,
      });
      expect(toHex(encodeFrame(frame.type, frame.sid, fromHex(frame.payload)))).toBe(frame.hex);
    }
    expect(decodeFrame(new Uint8Array(4))).toBeNull();
    expect(readClose(fromHex(relay.frames[2]?.payload ?? ""))).toBe(4404);
    expect(readClose(new Uint8Array(3))).toBeNull();
  });
});
