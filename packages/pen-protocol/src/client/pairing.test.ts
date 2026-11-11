// @effect-diagnostics nodeBuiltinImport:off - node:crypto is the independent reference for the derivations.
import * as NodeCrypto from "node:crypto";
import { APP_SCHEMES } from "@goat/shared/mobileAppIdentity";
import { describe, expect, it } from "vite-plus/test";
import { fromHex, toBase64Url, toHex } from "./bytes.ts";
import {
  decodePairQr,
  encodePairQr,
  filterRelays,
  PAIR_LINK_SCHEMES,
  pairingCode,
  pairingSas,
  type PairQrFields,
  serviceInviteId,
  servicePairPayload,
  servicePayload,
  servicePsk,
} from "./pairing.ts";

const RELAY_A = "https://pen-relay.pos090001.workers.dev";
const RELAY_B = "https://158-180-76-7.sslip.io";
const compiledRelays = [RELAY_A, RELAY_B, "wss://a"];
const now = 1_800_000_000;
const fields: PairQrFields = {
  nodeId: "cc5gqlek2e2rhfy6rnliqgvlrm",
  serverNoisePub: fromHex("0f".repeat(32)),
  secret: fromHex("55".repeat(32)),
  expiresAt: now + 300,
  relays: [RELAY_A, RELAY_B],
};
const options = { compiledRelays, nowSeconds: now };
const link = (bytes: Uint8Array, scheme = "goat") => scheme + "://pair?pen=" + toBase64Url(bytes);
const refusal = (input: string | Uint8Array, opts = options) => {
  try {
    decodePairQr(input, opts);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "accepted";
};
// Hand-built payloads for layout rules the encoder would never produce.
function layout(parts: {
  version?: number;
  relayCount?: number;
  relays?: ReadonlyArray<Uint8Array>;
  trailing?: Uint8Array;
  serverKey?: Uint8Array;
  expiresAt?: number;
}) {
  const head = new Uint8Array(86);
  head[0] = parts.version ?? 1;
  head.set(fromHex("10ba7ee5642e15893c6a6c4e2c8fa6ad").subarray(0, 16), 1);
  head.set(parts.serverKey ?? fields.serverNoisePub, 17);
  head.set(fields.secret, 49);
  new DataView(head.buffer).setUint32(81, parts.expiresAt ?? fields.expiresAt);
  const relays = parts.relays ?? [new TextEncoder().encode("wss://a")];
  head[85] = parts.relayCount ?? relays.length;
  const chunks: Array<number> = [...head];
  for (const relay of relays) chunks.push(relay.length, ...relay);
  chunks.push(...(parts.trailing ?? []));
  return Uint8Array.from(chunks);
}
const url = (text: string) => new TextEncoder().encode(text);

describe("pairing QR (design 9.1, 9.3)", () => {
  it("round trips one and two relays at the smallest reachable valid size (94 bytes) and at 216 bytes", () => {
    const smallest = encodePairQr({ ...fields, relays: ["wss://a"] });
    expect(smallest.length).toBe(94);
    expect(decodePairQr(link(smallest), options)).toMatchObject({
      nodeId: fields.nodeId,
      relays: ["wss://a"],
      expiresAt: fields.expiresAt,
    });
    const long = (label: string) => "https://" + label + "x".repeat(53 - label.length) + ".io";
    const largest = encodePairQr({ ...fields, relays: [long("a"), long("b")] });
    expect(largest.length).toBe(216);
    const decoded = decodePairQr(largest, {
      ...options,
      compiledRelays: [long("a"), long("b")],
    });
    expect(decoded.relays).toEqual(
      [long("a"), long("b")].map((u) => u.replace("https://", "wss://")),
    );
    expect(toHex(decoded.secret)).toBe(toHex(fields.secret));
    expect(toHex(decoded.serverNoisePub)).toBe(toHex(fields.serverNoisePub));
  });

  it("normalizes https and wss relay URLs to one wss origin and keeps the release relays", () => {
    const decoded = decodePairQr(link(encodePairQr(fields)), options);
    expect(decoded.relays).toEqual([
      "wss://pen-relay.pos090001.workers.dev",
      "wss://158-180-76-7.sslip.io",
    ]);
    expect(
      decodePairQr(
        encodePairQr({ ...fields, relays: ["WSS://Pen-Relay.POS090001.workers.dev:443/"] }),
        options,
      ).relays,
    ).toEqual(["wss://pen-relay.pos090001.workers.dev"]);
  });

  it.each([
    ["version 0", layout({ version: 0 }), "qr/version"],
    ["version 2", layout({ version: 2 }), "qr/version"],
    ["87 bytes", layout({}).subarray(0, 87), "qr/length"],
    ["217 bytes", new Uint8Array(217), "qr/length"],
    ["a trailing byte", layout({ trailing: Uint8Array.of(0) }), "qr/trailing"],
    ["relay count 0", layout({ relayCount: 0 }), "qr/relay-count"],
    [
      "relay count 3",
      layout({ relays: [url("wss://a"), url("wss://b"), url("wss://c")] }),
      "qr/relay-count",
    ],
    [
      "a zero-length relay",
      layout({ relays: [new Uint8Array(0)], trailing: new Uint8Array(8) }),
      "qr/relay-length",
    ],
    ["a 65-byte relay", layout({ relays: [url("wss://" + "a".repeat(59))] }), "qr/relay-length"],
    ["scheme http", layout({ relays: [url("http://a")] }), "qr/relay-url"],
    ["scheme ws", layout({ relays: [url("ws://a")] }), "qr/relay-url"],
    ["port 8443", layout({ relays: [url("wss://a:8443")] }), "qr/relay-url"],
    ["a path", layout({ relays: [url("wss://a/v1")] }), "qr/relay-url"],
    ["a query", layout({ relays: [url("wss://a?x=1")] }), "qr/relay-url"],
    ["userinfo", layout({ relays: [url("wss://u@a")] }), "qr/relay-url"],
    ["a fragment", layout({ relays: [url("wss://a#f")] }), "qr/relay-url"],
    [
      "a duplicate origin",
      layout({ relays: [url("wss://a"), url("https://a:443")] }),
      "qr/relay-duplicate",
    ],
    [
      "an origin off the compiled list",
      layout({ relays: [url("wss://a"), url("wss://evil")] }),
      "qr/relay-not-allowed",
    ],
    ["an all-zero server key", layout({ serverKey: new Uint8Array(32) }), "qr/server-key"],
    ["an expiry more than 60 s past", layout({ expiresAt: now - 61 }), "qr/expired"],
  ])("refuses %s", (_name, payload, code) => {
    expect(refusal(payload)).toBe(code);
  });

  it("accepts an expiry up to 60 s in the past (clock skew; the daemon enforces the real one)", () => {
    expect(refusal(layout({ expiresAt: now - 60 }))).toBe("accepted");
  });

  it("a link of the largest QR (288 payload characters) decodes; a longer or very long link is refused as too long", () => {
    const long = (label: string) => "https://" + label + "x".repeat(53 - label.length) + ".io";
    const largest = encodePairQr({ ...fields, relays: [long("a"), long("b")] });
    const largestLink = link(largest, "goat-preview");
    expect(largestLink.length).toBe("goat-preview://pair?pen=".length + 288);
    expect(
      decodePairQr(largestLink, { ...options, compiledRelays: [long("a"), long("b")] }).relays,
    ).toHaveLength(2);
    expect(refusal(link(Uint8Array.of(...largest, 0)))).toBe("qr/length");
    expect(refusal("goat://pair?pen=" + "A".repeat(4_000_000))).toBe("qr/length");
  });

  it.each([
    ["the pairingUrl link of Tailscale pairing", "goat://pair?pairingUrl=https%3A%2F%2Fhost"],
    ["both parameters", link(layout({})) + "&pairingUrl=x"],
    ["the legacy t3code scheme", link(layout({}), "t3code")],
    ["an unknown channel suffix", link(layout({}), "goat-x")],
    ["padded base64url", link(layout({})) + "="],
    ["another host", link(layout({})).replace("://pair", "://pairing")],
  ])("is not a Pen QR: %s", (_name, text) => {
    expect(refusal(text)).toBe("qr/link");
  });

  it("accepts exactly the app's own schemes", () => {
    expect([...PAIR_LINK_SCHEMES].sort()).toEqual([...APP_SCHEMES].sort());
    for (const scheme of PAIR_LINK_SCHEMES)
      expect(refusal(link(layout({}), scheme))).toBe("accepted");
  });

  it("a relay list sent later is filtered to the compiled list; an empty result keeps the current list", () => {
    const current = ["wss://pen-relay.pos090001.workers.dev"];
    expect(filterRelays(compiledRelays, ["wss://evil", RELAY_B], current)).toEqual([
      "wss://158-180-76-7.sslip.io",
    ]);
    expect(filterRelays(compiledRelays, ["wss://evil"], current)).toEqual(current);
  });
});

describe("pairing derivations (design 5.1) against node:crypto", () => {
  const secret = fields.secret;
  it('invite id is base64url of SHA-256("pen/1 service invite" || S)[0..12]', () => {
    const digest = NodeCrypto.createHash("sha256")
      .update("pen/1 service invite")
      .update(secret)
      .digest();
    expect(serviceInviteId(secret)).toBe(digest.subarray(0, 12).toString("base64url"));
    expect(serviceInviteId(secret)).toHaveLength(16);
  });

  it('psk is HKDF-SHA256(S, empty salt, "pen/1 service psk" || nodeId || serverNoisePub || name, 32)', () => {
    const info = Buffer.concat([
      Buffer.from("pen/1 service psk" + fields.nodeId),
      Buffer.from(fields.serverNoisePub),
      Buffer.from("goat"),
    ]);
    const expected = Buffer.from(NodeCrypto.hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
    expect(toHex(servicePsk(secret, fields.nodeId, fields.serverNoisePub, "goat"))).toBe(
      expected.toString("hex"),
    );
  });

  it('sas is SHA-256("goat-pair/1 sas" || h) and the code is its first 8 bytes as a big-endian u64 mod 10^6', () => {
    const h = fromHex("27c06c9f262b5b3332ee9a05d0cd0f32b5ec535643db53883fb561249381ad17");
    const sas = NodeCrypto.createHash("sha256").update("goat-pair/1 sas").update(h).digest();
    expect(toHex(pairingSas(h))).toBe(sas.toString("hex"));
    expect(pairingCode(sas)).toBe(
      (sas.readBigUInt64BE(0) % 1_000_000n).toString().padStart(6, "0"),
    );
  });

  it("the code keeps leading zeros and handles the largest u64", () => {
    const sas = new Uint8Array(32);
    sas.set(fromHex("00000000000003e8")); // 1000
    expect(pairingCode(sas)).toBe("001000");
    sas.set(fromHex("ffffffffffffffff"));
    expect(pairingCode(sas)).toBe(((2n ** 64n - 1n) % 1_000_000n).toString().padStart(6, "0"));
  });

  it("message 1 payloads follow Go's Payload member order (v, stream, invite, name)", () => {
    expect(JSON.stringify(servicePairPayload("goat", "PI77rMJo0ciLFOT_"))).toBe(
      '{"v":1,"stream":"service-pair","invite":"PI77rMJo0ciLFOT_","name":"goat"}',
    );
    expect(JSON.stringify(servicePayload("goat"))).toBe('{"v":1,"stream":"service","name":"goat"}');
  });
});
