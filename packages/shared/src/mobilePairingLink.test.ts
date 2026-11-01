import { describe, expect, it } from "vite-plus/test";

import {
  buildMobilePairingLink,
  MOBILE_PAIRING_URL_PARAM,
  readPairingAppLink,
} from "./mobilePairingLink.ts";

describe("buildMobilePairingLink", () => {
  it("wraps the pairing URL, fragment token included, in a goat://pair link", () => {
    const pairingUrl = "https://hub.tail1234.ts.net/pair#token=abc+def/1";
    const link = buildMobilePairingLink(pairingUrl);

    expect(link.startsWith("goat://pair?")).toBe(true);
    expect(new URL(link).hash).toBe("");
    expect(new URL(link).searchParams.get(MOBILE_PAIRING_URL_PARAM)).toBe(pairingUrl);
  });
});

describe("readPairingAppLink", () => {
  it("reads the pairing URL back from pair links on GOAT and legacy T3 Code schemes", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const link = buildMobilePairingLink(pairingUrl);
    const query = new URL(link).search;

    expect(readPairingAppLink(link)).toBe(pairingUrl);
    for (const scheme of ["goat-dev", "goat-preview", "t3code", "t3code-dev"]) {
      expect(readPairingAppLink(`${scheme}://pair${query}`)).toBe(pairingUrl);
    }
  });

  it("rejects links that are not a pair link carrying a pairing URL", () => {
    const query = new URL(buildMobilePairingLink("https://vps.example.com/pair#token=ABC123"))
      .search;

    expect(readPairingAppLink("goat://pair")).toBeNull();
    expect(readPairingAppLink("goat://pair?pairingUrl=%20")).toBeNull();
    expect(readPairingAppLink(`goat://pair/other${query}`)).toBeNull();
    expect(readPairingAppLink(`goat://threads${query}`)).toBeNull();
    expect(readPairingAppLink(`https://pair${query}`)).toBeNull();
    expect(readPairingAppLink("not a url")).toBeNull();
  });
});
