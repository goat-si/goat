// @effect-diagnostics nodeBuiltinImport:off - node:crypto is the independent reference implementation.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { fromHex, toHex } from "./bytes.ts";
import {
  aeadOpen,
  aeadSeal,
  hkdfSha256,
  hmacSha256,
  sha256,
  x25519PublicKey,
  x25519Shared,
} from "./crypto.ts";

const key = fromHex("42".repeat(32));
const plaintext = new TextEncoder().encode("pen record");
const ad = new TextEncoder().encode("associated");

function nodeSeal(n: bigint) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  const cipher = NodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

describe("client crypto against node:crypto", () => {
  it("ChaCha20-Poly1305 with the Noise nonce matches at n = 0, 2^32 and 2^53 - 1, and opens what it sealed", () => {
    for (const n of [0, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const sealed = aeadSeal(key, n, ad, plaintext);
      expect(toHex(sealed)).toBe(toHex(nodeSeal(BigInt(n))));
      expect(toHex(aeadOpen(key, n, ad, sealed))).toBe(toHex(plaintext));
    }
  });

  it("a ciphertext shorter than its tag, or with a changed tag, fails with 4400", () => {
    expect(() => aeadOpen(key, 0, ad, new Uint8Array(15))).toThrow(
      expect.objectContaining({ code: "decrypt-failed", closeCode: 4400 }),
    );
    const sealed = aeadSeal(key, 0, ad, plaintext);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    expect(() => aeadOpen(key, 0, ad, sealed)).toThrow(
      expect.objectContaining({ code: "decrypt-failed" }),
    );
  });

  it("SHA-256, HMAC-SHA256 and HKDF-SHA256 match node:crypto", () => {
    const ikm = fromHex("0b".repeat(32));
    const info = new TextEncoder().encode("pen/1 service psk");
    expect(toHex(sha256(ikm, info))).toBe(
      NodeCrypto.createHash("sha256").update(ikm).update(info).digest("hex"),
    );
    expect(toHex(hmacSha256(ikm, info))).toBe(
      NodeCrypto.createHmac("sha256", ikm).update(info).digest("hex"),
    );
    expect(toHex(hkdfSha256(ikm, new Uint8Array(0), info, 32))).toBe(
      Buffer.from(NodeCrypto.hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32)).toString("hex"),
    );
  });

  it("X25519 agrees with node:crypto, and a low-order peer key giving an all-zero secret is refused", () => {
    const a = fromHex("11".repeat(32));
    const b = fromHex("22".repeat(32));
    const nodeKey = (priv: Uint8Array) =>
      NodeCrypto.createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), priv]),
        format: "der",
        type: "pkcs8",
      });
    const expected = NodeCrypto.diffieHellman({
      privateKey: nodeKey(a),
      publicKey: NodeCrypto.createPublicKey(nodeKey(b)),
    });
    expect(toHex(x25519Shared(a, x25519PublicKey(b)))).toBe(expected.toString("hex"));
    expect(() => x25519Shared(a, new Uint8Array(32))).toThrow(
      expect.objectContaining({ code: "dh-invalid" }),
    );
  });
});
