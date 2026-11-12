import { describe, expect, it } from "vite-plus/test";
import identity from "../vectors/identity.json" with { type: "json" };
import { base32, fingerprint, fromHex, isNodeId, nodeIdFromSignPub } from "./identity.ts";
import { buildIdentityVector } from "./vectors.ts";

describe("identity vectors (CONTRACT Identities)", () => {
  it("nodeId, noisePub and fingerprint recomputed from the fixed seeds match vectors/identity.json", async () => {
    expect(await buildIdentityVector()).toEqual(identity);
  });

  it("nodeId is 26 lowercase base32 characters of SHA-256(signPub)[0..16]", async () => {
    const nodeId = await nodeIdFromSignPub(fromHex(identity.signPub));
    expect(nodeId).toBe(identity.nodeId);
    expect(isNodeId(nodeId)).toBe(true);
    expect(isNodeId(nodeId.toUpperCase())).toBe(false);
    expect(isNodeId(nodeId.slice(1))).toBe(false);
  });

  it("fingerprint is uppercase hex of SHA-256(noisePub)[0..20] in 10 groups of 4", async () => {
    expect(await fingerprint(fromHex(identity.noisePub))).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){9}$/);
  });

  it("base32 follows RFC 4648 test vectors, lowercase without padding", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["f", "my"],
      ["fo", "mzxq"],
      ["foo", "mzxw6"],
      ["foob", "mzxw6yq"],
      ["fooba", "mzxw6ytb"],
      ["foobar", "mzxw6ytboi"],
    ];
    for (const [input, output] of cases)
      expect(base32(new TextEncoder().encode(input))).toBe(output);
  });
});
