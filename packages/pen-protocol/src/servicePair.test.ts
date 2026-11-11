// @effect-diagnostics nodeBuiltinImport:off - an independent replay of the Go vectors with node:crypto.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import pair from "../vectors/servicepair.json" with { type: "json" };
import service from "../vectors/service.json" with { type: "json" };
import framing from "../vectors/stream.json" with { type: "json" };
import { decodeKey32, verifyServiceIdentity } from "./service.ts";

// CONTRACT "Service clients (v1.3)". These derivations are written out here, apart from any client library, so
// they check the Go generator against the contract text.

const hex = (text: string) => Buffer.from(text, "hex");
const sha256 = (...parts: ReadonlyArray<Uint8Array>) => {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const ascii = (text: string) => Buffer.from(text, "ascii");
const b64 = (text: string) => Buffer.from(text, "base64url");

const code = (sas: Uint8Array) =>
  (Buffer.from(sas).readBigUInt64BE(0) % 1_000_000n).toString().padStart(6, "0");

/** Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s up to message 2, initiator view; returns both messages and h. */
function replayIKpsk2(input: {
  readonly prologue: Buffer;
  readonly responderStatic: Buffer;
  readonly initiatorStatic: Buffer;
  readonly initiatorEphemeral: Buffer;
  readonly responderEphemeral: Buffer;
  readonly psk: Buffer;
  readonly kind: number;
  readonly payload1: Buffer;
  readonly payload2: Buffer;
}) {
  const blake = (...parts: ReadonlyArray<Uint8Array>) => {
    const hash = NodeCrypto.createHash("blake2s256");
    for (const part of parts) hash.update(part);
    return hash.digest();
  };
  const hmac = (key: Uint8Array, ...parts: ReadonlyArray<Uint8Array>) => {
    const mac = NodeCrypto.createHmac("blake2s256", key);
    for (const part of parts) mac.update(part);
    return mac.digest();
  };
  const hkdf = (chainingKey: Uint8Array, ikm: Uint8Array) => {
    const temp = hmac(chainingKey, ikm);
    const one = hmac(temp, Uint8Array.of(1));
    const two = hmac(temp, one, Uint8Array.of(2));
    const three = hmac(temp, two, Uint8Array.of(3));
    return [one, two, three] as const;
  };
  const privateKey = (raw: Buffer) =>
    NodeCrypto.createPrivateKey({
      key: Buffer.concat([hex("302e020100300506032b656e04220420"), raw]),
      format: "der",
      type: "pkcs8",
    });
  const publicOf = (raw: Buffer) => {
    const jwk = NodeCrypto.createPublicKey(privateKey(raw)).export({ format: "jwk" });
    return b64(jwk.x ?? "");
  };
  const dh = (secret: Buffer, peer: Buffer) =>
    NodeCrypto.diffieHellman({
      privateKey: privateKey(secret),
      publicKey: NodeCrypto.createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: peer.toString("base64url") },
        format: "jwk",
      }),
    });
  let h = blake(ascii("Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s"));
  let ck: Buffer = h;
  let k: Buffer | null = null;
  let n = 0n;
  const mixHash = (data: Uint8Array) => {
    h = blake(h, data);
  };
  const mixKey = (ikm: Uint8Array) => {
    const [next, key] = hkdf(ck, ikm);
    ck = next;
    k = key;
    n = 0n;
  };
  const mixKeyAndHash = (ikm: Uint8Array) => {
    const [next, temp, key] = hkdf(ck, ikm);
    ck = next;
    mixHash(temp);
    k = key;
    n = 0n;
  };
  const encryptAndHash = (plain: Buffer) => {
    if (k === null) throw new Error("no key");
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(n, 4);
    const cipher = NodeCrypto.createCipheriv("chacha20-poly1305", k, nonce, { authTagLength: 16 });
    cipher.setAAD(h);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    n += 1n;
    mixHash(sealed);
    return sealed;
  };
  const responderPub = publicOf(input.responderStatic);
  mixHash(input.prologue);
  mixHash(responderPub);
  // Message 1: e, es, s, ss. In a psk handshake e also mixes the key.
  const e = publicOf(input.initiatorEphemeral);
  mixHash(e);
  mixKey(e);
  mixKey(dh(input.initiatorEphemeral, responderPub));
  const sealedStatic = encryptAndHash(publicOf(input.initiatorStatic));
  mixKey(dh(input.initiatorStatic, responderPub));
  const sealed1 = encryptAndHash(input.payload1);
  const message1 = Buffer.concat([Uint8Array.of(input.kind), e, sealedStatic, sealed1]);
  // Message 2: e, ee, se, psk.
  const re = publicOf(input.responderEphemeral);
  mixHash(re);
  mixKey(re);
  mixKey(dh(input.initiatorEphemeral, re));
  mixKey(dh(input.initiatorStatic, re));
  mixKeyAndHash(input.psk);
  const message2 = Buffer.concat([re, encryptAndHash(input.payload2)]);
  return { message1, message2, h };
}

describe("service-pair vectors (CONTRACT Service invites, v1.3)", () => {
  const node = { noisePub: b64(pair.node.noisePub), nodeId: pair.node.nodeId };

  it("the invite id and psk follow from S, the node and the name", () => {
    const secret = hex(pair.secret);
    expect(
      sha256(ascii("pen/1 service invite"), secret).subarray(0, 12).toString("base64url"),
    ).toBe(pair.inviteId);
    const info = Buffer.concat([
      ascii("pen/1 service psk" + node.nodeId),
      node.noisePub,
      ascii(pair.name),
    ]);
    const psk = Buffer.from(NodeCrypto.hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
    expect(psk.toString("hex")).toBe(pair.psk);
  });

  it("an independent replay of the IKpsk2 service-pair handshake gives the same messages and h", () => {
    const transcript = pair.transcript;
    expect(JSON.parse(transcript.payload1)).toEqual({
      v: 1,
      stream: "service-pair",
      invite: pair.inviteId,
      name: pair.name,
    });
    const replay = replayIKpsk2({
      prologue: hex(transcript.prologue),
      responderStatic: hex(pair.node.noisePriv),
      initiatorStatic: hex(pair.phone.noisePriv),
      initiatorEphemeral: hex(transcript.initiatorEphemeralPriv),
      responderEphemeral: hex(transcript.responderEphemeralPriv),
      psk: hex(transcript.psk),
      kind: transcript.kind,
      payload1: Buffer.from(transcript.payload1, "utf8"),
      payload2: Buffer.from(transcript.payload2, "utf8"),
    });
    expect(transcript.kind).toBe(3);
    expect(transcript.prologue).toBe(
      Buffer.concat([ascii("pen/1" + node.nodeId), Uint8Array.of(3)]).toString("hex"),
    );
    expect(replay.message1.toString("hex")).toBe(transcript.message1);
    expect(replay.message2.toString("hex")).toBe(transcript.message2);
    expect(replay.h.toString("hex")).toBe(transcript.handshakeHash);
  });

  it("the sas and the six digits follow from h, including the boundary cases", () => {
    const sas = sha256(ascii("goat-pair/1 sas"), hex(pair.transcript.handshakeHash));
    expect(sas.toString("hex")).toBe(pair.sas);
    expect(sas.toString("base64url")).toBe(pair.sasText);
    expect(code(sas)).toBe(pair.code);
    for (const entry of pair.codes) {
      expect(code(Buffer.concat([hex(entry.sasPrefix), Buffer.alloc(24)]))).toBe(entry.code);
    }
  });
});

describe("identity line forms (CONTRACT Identity line forms, v1.3)", () => {
  const key = decodeKey32(service.key);
  const nd = decodeKey32(service.nd);
  const ng = decodeKey32(service.ng);
  if (key === null || nd === null || ng === null) throw new Error("service.json keys");
  const mac = (identity: string) =>
    NodeCrypto.createHmac("sha256", key)
      .update(ascii("pen-svc/1 pen"))
      .update(nd)
      .update(ng)
      .update(Buffer.from(identity, "utf8"))
      .digest()
      .toString("base64url");

  it("the client and pairing lines have the stated layout and the same MAC as the member line", () => {
    expect(service.clientIdentity).toBe(
      JSON.stringify({
        v: 1,
        mesh: service.mesh,
        self: service.self,
        client: service.client,
        stream: service.name,
      }),
    );
    expect(service.pairingIdentity).toBe(
      JSON.stringify({
        v: 1,
        mesh: service.mesh,
        self: service.self,
        pairing: service.pairing,
        stream: service.name,
      }),
    );
    expect(mac(service.clientIdentity)).toBe(service.clientProof);
    expect(mac(service.pairingIdentity)).toBe(service.pairingProof);
    expect(service.clientLine3).toBe(service.clientIdentity + " " + service.clientProof + "\n");
    expect(service.pairingLine3).toBe(service.pairingIdentity + " " + service.pairingProof + "\n");
    expect(Buffer.byteLength(service.pairingLine3)).toBeLessThanOrEqual(2200);
  });

  it("the member-only reader (v1.2) refuses both new forms, so an older program fails closed", () => {
    const pin = { key, name: service.name, nd, ng, mesh: service.mesh, self: service.self };
    expect(() => verifyServiceIdentity(Buffer.from(service.clientLine3), pin)).toThrow();
    expect(() => verifyServiceIdentity(Buffer.from(service.pairingLine3), pin)).toThrow();
  });

  it("every reject line for the new forms carries a MAC right for its bytes except the wrong-MAC case", () => {
    for (const reject of [...service.rejectClientLine3, ...service.rejectPairingLine3]) {
      const line = reject.line.slice(0, -1);
      const space = line.lastIndexOf(" ");
      const right = mac(line.slice(0, space)) === line.slice(space + 1);
      expect(right, reject.why).toBe(reject.why !== "wrong MAC");
    }
  });
});

describe("tcp framing vectors (CONTRACT Streams)", () => {
  it("records are a type byte and its payload, CREDIT a little-endian u32", () => {
    expect(framing.maxData).toBe(65518);
    expect(framing.window).toBe(512 * 1024);
    expect(framing.creditEvery).toBe(64 * 1024);
    const [data, empty, fin, credit] = framing.records.map((record) => hex(record.hex));
    expect(data).toEqual(Buffer.concat([Uint8Array.of(0), ascii("hello")]));
    expect(empty).toEqual(Buffer.of(0));
    expect(fin).toEqual(Buffer.of(1));
    expect(credit?.[0]).toBe(2);
    expect(credit?.readUInt32LE(1)).toBe(65536);
  });

  it("every refused sequence names 4400, or 4408 for data past the window", () => {
    for (const reject of framing.reject) {
      const overrun = (reject.fill ?? 0) * (reject.fillSize ?? 0) > framing.window;
      expect(reject.code, reject.why).toBe(overrun ? 4408 : 4400);
    }
  });
});
