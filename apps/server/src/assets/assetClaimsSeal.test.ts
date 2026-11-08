import { describe, expect, it } from "@effect/vitest";

import { openAssetClaims, sealAssetClaims } from "./assetClaimsSeal.ts";

const secret = new Uint8Array(32).fill(7);
const json = JSON.stringify({ kind: "media-file-exact", filePath: "/Users/someone/clip.mp4" });

describe("asset claim sealing", () => {
  it("hides claim paths and opens to the same claims", () => {
    const sealed = sealAssetClaims(json, secret);
    expect(Buffer.from(sealed.slice(2), "base64url").toString("latin1")).not.toContain("/Users/");
    expect(sealed).toBe(sealAssetClaims(json, secret));
    expect(openAssetClaims(sealed, secret)).toBe(json);
  });

  it("refuses a payload sealed under another key or altered in transit", () => {
    const sealed = sealAssetClaims(json, secret);
    expect(openAssetClaims(sealed, new Uint8Array(32).fill(8))).toBeNull();
    const bytes = Buffer.from(sealed.slice(2), "base64url");
    bytes[bytes.length - 1]! ^= 1;
    expect(openAssetClaims(`s1${bytes.toString("base64url")}`, secret)).toBeNull();
    expect(openAssetClaims("s1AAAA", secret)).toBeNull();
  });

  it("still reads a plaintext payload minted before sealing", () => {
    expect(openAssetClaims(Buffer.from(json).toString("base64url"), secret)).toBe(json);
  });
});
