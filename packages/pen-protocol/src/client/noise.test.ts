// @effect-diagnostics nodeBuiltinImport:off - node:crypto is the independent reference for the rekey schedule.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import vector from "../../vectors/session.json" with { type: "json" };
import { fromHex, toHex } from "./bytes.ts";
import { x25519PublicKey } from "./crypto.ts";
import { PenError } from "./errors.ts";
import {
  cipherStateAt,
  encodePayloadLine,
  MAX_PLAINTEXT,
  REKEY_INTERVAL,
  startInitiator,
} from "./noise.ts";
import { respond } from "./testing/noiseResponder.ts";

const fixedRandom = (hex: string) => () => fromHex(hex);
const localStatic = (privHex: string) => {
  const privateKey = fromHex(privHex);
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
};
const responderKey = localStatic(vector.responder.noisePriv);
const initiatorKey = localStatic(vector.initiator.noisePriv);
const payload = (text: string) => JSON.parse(text.trimEnd()) as Record<string, unknown>;
const utf8 = (text: string) => new TextEncoder().encode(text);

const cases = [
  { name: "IK (kind 0x01)", data: vector.ik, psk: undefined },
  { name: "IKpsk2 (kind 0x03)", data: vector.ikpsk2, psk: fromHex(vector.ikpsk2.psk) },
] as const;

function initiate(data: (typeof cases)[number]["data"], psk: Uint8Array | undefined) {
  return startInitiator({
    kind: data.kind as 1 | 3,
    nodeId: vector.responder.nodeId,
    remoteStatic: responderKey.publicKey,
    localStatic: initiatorKey,
    payload: payload(data.payload1),
    ...(psk ? { psk } : {}),
    random: fixedRandom(data.initiatorEphemeralPriv),
  });
}

describe("Noise initiator against vectors/session.json (CONTRACT Sessions, Record layer)", () => {
  it.each(cases)("$name: message 1 equals the Go transcript byte for byte", ({ data, psk }) => {
    expect(toHex(initiate(data, psk).message1)).toBe(data.message1);
  });

  it.each(cases)(
    "$name: the vector's message 2 yields its handshake hash, key confirmation and both records",
    ({ data, psk }) => {
      const keys = initiate(data, psk).readMessage2(fromHex(data.message2));
      expect(toHex(keys.handshakeHash)).toBe(data.handshakeHash);
      expect(toHex(keys.send.seal(new Uint8Array(0)))).toBe(data.keyConfirmation);
      expect(toHex(keys.send.seal(utf8(data.initiatorRecordPlaintext)))).toBe(data.initiatorRecord);
      expect(new TextDecoder().decode(keys.recv.open(fromHex(data.responderRecord)))).toBe(
        data.responderRecordPlaintext,
      );
    },
  );

  it.each(cases)(
    "$name: the testkit responder writes the vector's message 2 from its ephemeral key",
    ({ data, psk }) => {
      const answer = respond({
        kind: data.kind as 1 | 3,
        nodeId: vector.responder.nodeId,
        localStatic: responderKey,
        message1: fromHex(data.message1),
        psk: () => psk,
        random: fixedRandom(data.responderEphemeralPriv),
      });
      expect(toHex(answer.message2)).toBe(data.message2);
      expect(toHex(answer.handshakeHash)).toBe(data.handshakeHash);
      expect(toHex(answer.remoteStatic)).toBe(toHex(initiatorKey.publicKey));
    },
  );

  it("a message 2 with a flipped bit, a truncation or another payload is bad-message-2 (4400) and yields no keys", () => {
    const good = fromHex(vector.ik.message2);
    const flipped = good.slice();
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    const otherPayload = respond({
      kind: 1,
      nodeId: vector.responder.nodeId,
      localStatic: responderKey,
      message1: fromHex(vector.ik.message1),
      psk: () => undefined,
      random: fixedRandom(vector.ik.responderEphemeralPriv),
      payload2: utf8('{"v":2}\n'),
    }).message2;
    for (const bad of [flipped, good.subarray(0, good.length - 1), otherPayload]) {
      const error = (() => {
        try {
          initiate(vector.ik, undefined).readMessage2(bad);
        } catch (cause) {
          return cause;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(PenError);
      expect(error).toMatchObject({ code: "bad-message-2", closeCode: 4400 });
    }
  });

  it("a payload line over 256 bytes is refused before message 1 exists (with it, message 1 is at most 353 bytes, under the 4,096-byte first-message cap)", () => {
    expect(() => encodePayloadLine({ v: 1, stream: "x".repeat(250) })).toThrow(
      expect.objectContaining({ code: "payload-too-large" }),
    );
    expect(encodePayloadLine({ v: 1, stream: "x".repeat(236) }).length).toBe(256);
  });

  it("a record carries at most 65,519 plaintext bytes and a tampered record fails with 4400", () => {
    const keys = initiate(vector.ik, undefined).readMessage2(fromHex(vector.ik.message2));
    expect(keys.send.seal(new Uint8Array(MAX_PLAINTEXT)).length).toBe(MAX_PLAINTEXT + 16);
    expect(() => keys.send.seal(new Uint8Array(MAX_PLAINTEXT + 1))).toThrow(
      expect.objectContaining({ code: "record-too-large" }),
    );
    const record = fromHex(vector.ik.responderRecord);
    record[0] = (record[0] ?? 0) ^ 1;
    expect(() => keys.recv.open(record)).toThrow(
      expect.objectContaining({ code: "decrypt-failed", closeCode: 4400 }),
    );
  });

  it("a Random that throws or returns too few bytes refuses message 1", () => {
    for (const random of [
      () => {
        throw new Error("no entropy");
      },
      () => new Uint8Array(31),
    ]) {
      expect(() =>
        startInitiator({
          kind: 1,
          nodeId: vector.responder.nodeId,
          remoteStatic: responderKey.publicKey,
          localStatic: initiatorKey,
          payload: { v: 1, stream: "service", name: "goat" },
          random,
        }),
      ).toThrow(expect.objectContaining({ code: "random-unavailable" }));
    }
  });
});

// Reference: ChaCha20-Poly1305 with the Noise nonce (4 zero bytes, then n as 64-bit little-endian) and
// REKEY = ENCRYPT(k, 2^64 - 1, empty ad, 32 zero bytes)[0..32], computed by node:crypto.
function nodeNonce(n: bigint) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}
function nodeSeal(key: Uint8Array, n: bigint, plaintext: Uint8Array) {
  const cipher = NodeCrypto.createCipheriv("chacha20-poly1305", key, nodeNonce(n), {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.alloc(0), { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function nodeRekey(key: Uint8Array) {
  return nodeSeal(key, 2n ** 64n - 1n, new Uint8Array(32)).subarray(0, 32);
}

describe("rekey boundary (CONTRACT Record layer: REKEY every 2^20 messages per direction, n not reset)", () => {
  const key = fromHex("0f".repeat(32));
  const start = REKEY_INTERVAL - 2;
  const plaintexts = [
    utf8("old key, n = 2^20 - 2"),
    utf8("old key, n = 2^20 - 1"),
    utf8("new key, n = 2^20"),
  ];
  const reference = () => {
    const nextKey = nodeRekey(key);
    return [
      nodeSeal(key, BigInt(start), plaintexts[0] ?? new Uint8Array()),
      nodeSeal(key, BigInt(start + 1), plaintexts[1] ?? new Uint8Array()),
      nodeSeal(nextKey, BigInt(start + 2), plaintexts[2] ?? new Uint8Array()),
    ];
  };

  it("sending: the record at n = 2^20 - 1 is the last under the old key and n = 2^20 the first under the new one", () => {
    const state = cipherStateAt(key, start);
    const sealed = plaintexts.map((plaintext) => toHex(state.seal(plaintext)));
    expect(sealed).toEqual(reference().map((record) => toHex(record)));
    expect(state.nonce).toBe(REKEY_INTERVAL + 1);
  });

  it("receiving: the same three records open in order across the boundary", () => {
    const state = cipherStateAt(key, start);
    const opened = reference().map((record) => new TextDecoder().decode(state.open(record)));
    expect(opened).toEqual(plaintexts.map((plaintext) => new TextDecoder().decode(plaintext)));
  });

  it("the key confirmation is the initiator's message 0, so its first rekey follows its message 2^20 - 1", () => {
    const keys = initiate(vector.ik, undefined).readMessage2(fromHex(vector.ik.message2));
    keys.send.seal(new Uint8Array(0));
    expect(keys.send.nonce).toBe(1);
  });

  it("a nonce past 2^53 - 1 is refused instead of wrapping", () => {
    expect(() => cipherStateAt(key, Number.MAX_SAFE_INTEGER).seal(new Uint8Array(1))).toThrow(
      expect.objectContaining({ code: "nonce-exhausted" }),
    );
  });
});
