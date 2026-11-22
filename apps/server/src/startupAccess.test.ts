import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import type * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as NetAddress from "effect/net/NetAddress";
import { buildMobilePairingLink } from "@goat/shared/mobilePairingLink";
import {
  acceptsPrivateNetworkConnection,
  formatHeadlessServeOutput,
  loopbackUrlHostForAddress,
  makePrivateNetworkConnectionHandler,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";
const ipv4 = (address: string, internal = false): NodeOS.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

it("targets the bound interface when the listener binds a specific address", () => {
  const hostFor = (ip: string) =>
    loopbackUrlHostForAddress(NetAddress.inetAddressFromIpStringUnsafe(ip, 3773));
  expect(hostFor("0.0.0.0")).toBe("127.0.0.1");
  expect(hostFor("::")).toBe("127.0.0.1");
  expect(hostFor("::1")).toBe("[::1]");
  expect(hostFor("127.0.0.1")).toBe("127.0.0.1");
  expect(hostFor("127.0.0.2")).toBe("127.0.0.2");
  expect(hostFor("100.101.102.103")).toBe("100.101.102.103");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    interfaces: { en0: [ipv4("192.168.1.42")], lo0: [ipv4("127.0.0.1", true)] },
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Warning: this address uses plain HTTP.");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  expect(output).toContain(
    `App link: ${buildMobilePairingLink("http://192.168.1.42:3773/pair#token=PAIRCODE")}`,
  );
  // The QR opens the phone app; the printed URL stays the browser link.
  expect(output).toContain(
    renderTerminalQrCode(buildMobilePairingLink("http://192.168.1.42:3773/pair#token=PAIRCODE")),
  );
});

it("does not warn about plain HTTP on loopback", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://localhost:3773",
    token: "PAIRCODE",
    pairingUrl: "http://localhost:3773/pair#token=PAIRCODE",
  });
  expect(output).not.toContain("Warning: this address uses plain HTTP.");
});

it("skips public and container addresses for a private-network listener", () => {
  const interfaces = {
    eth0: [ipv4("203.0.113.7")],
    docker0: [ipv4("172.17.0.1")],
    bridge200: [ipv4("192.168.64.1")],
    eth1: [ipv4("10.0.0.5")],
  };

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, privateNetworkOnly: true }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://localhost:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://192.168.1.42:3773");
});

it("skips Windows VirtualBox and VMware host-only adapters for a private-network listener", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: {
        "VirtualBox Host-Only Network": [{ ...ipv4("192.168.56.1"), mac: "0a:00:27:00:00:0a" }],
        "VMware Network Adapter VMnet8": [{ ...ipv4("192.168.159.1"), mac: "00:50:56:c0:00:08" }],
        "Wi-Fi": [{ ...ipv4("192.168.1.20"), mac: "3c:22:fb:12:34:56" }],
      },
      privateNetworkOnly: true,
      platform: "win32",
    }),
  ).toBe("http://192.168.1.20:3773");
});

describe("acceptsPrivateNetworkConnection", () => {
  const accepts = (localAddress: string | undefined, remoteAddress: string | undefined) =>
    acceptsPrivateNetworkConnection({ localAddress, remoteAddress });

  it("serves loopback, LAN, and tailnet clients", () => {
    expect(accepts("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(accepts("::ffff:192.168.1.20", "::ffff:192.168.1.31")).toBe(true);
    expect(accepts("100.101.102.103", "100.90.1.2")).toBe(true);
  });

  it("closes connections from or to a public address", () => {
    // A cloud VM's public address is NATed to a private interface address.
    expect(accepts("172.31.4.10", "203.0.113.7")).toBe(false);
    expect(accepts("203.0.113.7", "192.168.1.31")).toBe(false);
    expect(accepts("169.254.10.1", "169.254.10.2")).toBe(false);
    expect(accepts(undefined, "192.168.1.31")).toBe(false);
  });
});

it("keeps a routable Linux bridge in a private-network pairing URL", () => {
  const options = {
    interfaces: {
      "ve-container": [ipv4("10.11.0.1")],
      "vb-container": [ipv4("10.12.0.1")],
      "vz-container": [ipv4("10.13.0.1")],
      vmbr0: [ipv4("192.168.2.1")],
    },
    privateNetworkOnly: true,
    platform: "linux" as const,
  };
  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, options)).toBe("http://192.168.2.1:3773");
  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { ...options, platform: "win32" })).toBe(
    "http://10.11.0.1:3773",
  );
});

it.effect("closes public connections and bounds rejection logs across a flood", () => {
  const warnings: Array<ReadonlyArray<unknown>> = [];
  return Effect.gen(function* () {
    const handle = yield* makePrivateNetworkConnectionHandler;
    let destroyed = 0;
    const destroy = () => {
      destroyed++;
    };
    handle({ localAddress: "192.168.1.2", remoteAddress: "192.168.1.3", destroy });
    expect(destroyed).toBe(0);
    const denied = { localAddress: "192.168.1.2", remoteAddress: "203.0.113.7", destroy };
    for (let n = 0; n < 40; n++) handle(denied);
    expect(destroyed).toBe(40);
    expect(warnings).toEqual([
      [
        "closed a connection outside the private network",
        { localAddress: "192.168.1.2", remoteAddress: "203.0.113.7" },
      ],
    ]);
    yield* TestClock.adjust("1 minute");
    handle({ localAddress: "192.168.1.2", destroy });
    expect(destroyed).toBe(41);
    expect(warnings[1]).toEqual([
      "closed a connection outside the private network",
      { localAddress: "192.168.1.2", remoteAddress: undefined, closedSinceLastLog: 39 },
    ]);
  }).pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push([message].flat());
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
});
