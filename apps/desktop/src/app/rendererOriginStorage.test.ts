// @effect-diagnostics globalDate:off - The page scripts store native Dates; the test feeds them in.
import { describe, expect, it } from "vite-plus/test";

import { STORAGE_VALUE_CODEC } from "./rendererOriginStorage.ts";

const codec = new Function(`${STORAGE_VALUE_CODEC}; return { encode, decode };`)() as {
  encode: (value: unknown) => Promise<unknown>;
  decode: (value: unknown) => Promise<unknown>;
};
const roundTrip = async (value: unknown) =>
  codec.decode(JSON.parse(JSON.stringify(await codec.encode(value))));

describe("renderer origin storage codec", () => {
  it("round-trips structured-clone values through JSON", async () => {
    const value = {
      text: "hi",
      count: 3,
      odd: [Number.NaN, Number.POSITIVE_INFINITY, -0, undefined, null, 10n],
      when: new Date(1_700_000_000_000),
      buffer: new Uint8Array([0, 1, 255]).buffer,
      view: new Float64Array([1.5, -2]),
      map: new Map<unknown, unknown>([["a", new Set([1, 2])]]),
      pattern: /goat/gi,
      // A stored object may use the tag key itself.
      $goat: "not a tag",
    };
    const decoded = (await roundTrip(value)) as typeof value;
    expect(decoded.text).toBe("hi");
    expect(decoded.odd[0]).toBeNaN();
    expect(decoded.odd.slice(1)).toEqual([Number.POSITIVE_INFINITY, -0, undefined, null, 10n]);
    expect(Object.is(decoded.odd[2], -0)).toBe(true);
    expect(decoded.when.getTime()).toBe(1_700_000_000_000);
    expect([...new Uint8Array(decoded.buffer)]).toEqual([0, 1, 255]);
    expect(decoded.view).toBeInstanceOf(Float64Array);
    expect([...decoded.view]).toEqual([1.5, -2]);
    expect(decoded.map.get("a")).toEqual(new Set([1, 2]));
    expect(decoded.pattern.flags).toBe("gi");
    expect(decoded.$goat).toBe("not a tag");
  });

  it("carries an extractable DPoP key that still signs for the same public key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const decoded = (await roundTrip({ privateKey: pair.privateKey })) as {
      privateKey: CryptoKey;
    };
    expect(decoded.privateKey.usages).toEqual(["sign"]);
    const data = new TextEncoder().encode("proof");
    const algorithm = { name: "ECDSA", hash: "SHA-256" };
    const signature = await crypto.subtle.sign(algorithm, decoded.privateKey, data);
    expect(await crypto.subtle.verify(algorithm, pair.publicKey, signature, data)).toBe(true);
  });

  it("rejects values it cannot carry, so the export skips that record", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    await expect(codec.encode({ key: pair.privateKey })).rejects.toThrow();
    await expect(codec.encode(new URL("goat://app/"))).rejects.toThrow(/Unsupported/);
  });
});
