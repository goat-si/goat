import { buildMobilePairingLink } from "@goat/shared/mobilePairingLink";
import { resolveRemotePairingTarget } from "@goat/shared/remote";
import { describe, expect, it } from "vite-plus/test";

import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("pairs with the address's own origin when the address carries a query", () => {
    const pairingUrl = buildPairingUrl(
      "https://remote.example.com/?host=https%3A%2F%2Fother.example.com",
      "pairing-token",
    );

    expect(pairingUrl).toBe("https://remote.example.com/#token=pairing-token");
    expect(resolveRemotePairingTarget({ pairingUrl })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    const pairingUrl = "https://hub.tail1234.ts.net/pair#token=pairing-token";
    expect(extractPairingUrlFromQrPayload(buildMobilePairingLink(pairingUrl))).toBe(pairingUrl);
    expect(
      extractPairingUrlFromQrPayload(
        "goat://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
    // QR codes printed for T3 Code still pair.
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token", // goat-rename: legacy
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
