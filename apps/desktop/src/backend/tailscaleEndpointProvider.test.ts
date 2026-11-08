import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";

import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const layerUnusedTailscaleExternalServices = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale status process")),
  ),
);

const protonAndTailscaleInterfaces = {
  pvpnksintrf1: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
  tailscale0: [{ address: "100.74.126.34", family: "IPv4", internal: false }],
};

describe("tailscale endpoint provider", () => {
  it.effect("does not advertise Proton's CGNAT address as a Tailscale pairing endpoint", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        networkInterfaces: protonAndTailscaleInterfaces,
        statusJson: `{"Self":{"TailscaleIPs":["100.74.126.34"]}}`,
      });
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.httpBaseUrl),
        ["http://100.74.126.34:3773/"],
      );
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect("keeps native Tailscale interfaces with missing, malformed, or stale status", () =>
    Effect.gen(function* () {
      for (const interfaceName of ["tailscale0", "Tailscale"]) {
        for (const statusJson of [null, "not-json", `{"Self":{"TailscaleIPs":[]}}`]) {
          const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
            port: 3773,
            networkInterfaces: {
              pvpnksintrf1: protonAndTailscaleInterfaces.pvpnksintrf1,
              [interfaceName]: protonAndTailscaleInterfaces.tailscale0,
            },
            statusJson,
          });
          assert.deepEqual(
            endpoints.map((endpoint) => endpoint.httpBaseUrl),
            ["http://100.74.126.34:3773/"],
          );
        }
      }
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect(
    "recognizes a macOS Tailscale tunnel by its IPv6 address when status is unavailable",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          networkInterfaces: {
            utun3: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
            utun4: [
              { address: "100.74.126.34", family: "IPv4", internal: false },
              { address: "fd7a:115c:a1e0::1234", family: "IPv6", internal: false },
            ],
          },
          statusJson: null,
        });
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://100.74.126.34:3773/"],
        );
      }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  const magicDns = `{"Self":{"DNSName":"desktop.tail.ts.net."}}`;
  const netshSample = `

Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     46648       46747
     50000       50059     *

* - Administered port exclusions.

`;

  it.effect("describes a refused Tailscale HTTPS port that Windows has not reserved", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        serveEnabled: true,
        servePort: 8443,
        networkInterfaces: {},
        statusJson: magicDns,
        probe: () => Effect.succeed("refused"),
      }).pipe(
        Effect.provide(layerUnusedTailscaleExternalServices),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const https = endpoints.find((endpoint) => endpoint.label === "Tailscale HTTPS");
      assert.equal(https?.status, "unavailable");
      assert.equal(
        https?.description,
        "Tailscale is running, but nothing answers on HTTPS port 8443. GOAT keeps trying to set it up; if this lasts, choose another port.",
      );
    }),
  );

  it.effect("describes a Tailscale HTTPS port reserved by Windows", () => {
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected command");
      assert.equal(command.command, "netsh.exe");
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(netshSample)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        serveEnabled: true,
        servePort: 46743,
        networkInterfaces: {},
        statusJson: magicDns,
        probe: () => Effect.succeed("refused"),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
            ),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "win32"),
          ),
        ),
      );
      const https = endpoints.find((endpoint) => endpoint.label === "Tailscale HTTPS");
      assert.equal(https?.status, "unavailable");
      assert.equal(
        https?.description,
        "Windows reserves TCP ports 46648\u201346747, so Tailscale HTTPS cannot use port 46743. Choose another port, such as 46748.",
      );
    });
  });

  it.effect("describes Tailscale HTTPS that does not answer", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        serveEnabled: true,
        servePort: 443,
        networkInterfaces: {},
        statusJson: magicDns,
        probe: () => Effect.succeed("no-answer"),
      }).pipe(Effect.provide(layerUnusedTailscaleExternalServices));
      const https = endpoints.find((endpoint) => endpoint.label === "Tailscale HTTPS");
      assert.equal(https?.status, "unavailable");
      assert.equal(
        https?.description,
        "Tailscale HTTPS is on, but Tailscale is not answering. Check that Tailscale is running and signed in on this computer.",
      );
    }),
  );
});
