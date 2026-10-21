import { expect, it } from "vite-plus/test";
import { OPENCODEX_CAPABILITIES, openCodexPairVerdict } from "./opencodexCompat.ts";

const negotiated = {
  protocol: 1,
  minimumClientProtocol: 1,
  relayAuthVersion: "2",
  features: ["remote-link"],
};

it.each(["2.83.0", "2.86.0"])(
  "2.89 Home and %s Child use served protocols, not version equality",
  (version) => {
    expect(
      openCodexPairVerdict({ version: "2.89.0", ...negotiated }, { version, ...negotiated }),
    ).toBe("compatible");
    expect(openCodexPairVerdict({ version: "2.89.0" }, { version })).toBe("degraded");
  },
);

it.each([
  [{ protocol: 3, minimumClientProtocol: 2 }, { protocol: 1 }, "incompatible"],
  [{ protocol: 1 }, { protocol: 3, minimumClientProtocol: 2 }, "incompatible"],
  [{ protocol: 3, minimumClientProtocol: 1 }, { protocol: 1 }, "compatible"],
  [{ relayAuthVersion: "2" }, { relayAuthVersion: "1" }, "incompatible"],
  [{ features: [] }, {}, "compatible"],
  [{ features: ["remote-link"] }, { features: ["remote-link"] }, "compatible"],
  [{ features: undefined }, {}, "compatible"],
  [{ protocol: 0 }, {}, "degraded"],
  [{ protocol: 1, minimumClientProtocol: 2 }, {}, "degraded"],
  [{ version: "2.10.0", protocol: undefined, features: undefined }, {}, "incompatible"],
  [{ version: "2.65.9", protocol: undefined, features: undefined }, {}, "incompatible"],
  [{ version: "2.66.0", protocol: undefined, features: undefined }, {}, "degraded"],
  [{ version: "unknown", protocol: undefined, features: undefined }, {}, "degraded"],
  [{ version: "2.0.0" }, { version: "5.0.0" }, "compatible"],
] as const)("pair verdict %j vs %j is %s", (home, child, expected) => {
  expect(openCodexPairVerdict({ ...negotiated, ...home }, { ...negotiated, ...child })).toBe(
    expected,
  );
});

it("optional capabilities degrade without rejecting a working relay", () => {
  expect(OPENCODEX_CAPABILITIES.remoteLink.minimumVersion).toBe("2.66.0");
  expect(
    openCodexPairVerdict(negotiated, negotiated, ["remoteLink", "quotaPool", "servedBy"]),
  ).toBe("degraded");
  const features = [
    "remote-link",
    "link-management-relay",
    "quota-pool/1",
    "served-by-header",
    "hub-client",
    "relay-auth/2",
  ];
  expect(
    openCodexPairVerdict({ ...negotiated, features }, { ...negotiated, features }, [
      "remoteLink",
      "managementRelay",
      "quotaPool",
      "servedBy",
      "hubClient",
    ]),
  ).toBe("compatible");
  expect(
    openCodexPairVerdict(
      { ...negotiated, relayAuthVersion: undefined, features },
      { ...negotiated, features },
    ),
  ).toBe("compatible");
});
