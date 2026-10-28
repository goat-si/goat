import { makeBackendHealthFramer } from "../../shared/src/managedRecoveryPolicy.ts";
import { expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopBackendBootstrap } from "./desktopBootstrap.ts";
import { DesktopBackendHealth } from "./desktopBackendHealth.ts";
const decodeHealth = Schema.decodeUnknownOption(DesktopBackendHealth);
const frame = {
  version: 1,
  type: "backendHealth",
  generation: "A",
  observerSequence: 1,
  mainSequence: 0,
  phase: "starting",
  verdict: "healthy",
};
it("decodes fragmented private health frames and rejects unsafe sequences and oversized lines", () => {
  const framer = makeBackendHealthFramer();
  const raw = new TextEncoder().encode(JSON.stringify(frame) + "\n");
  expect(framer.push(raw.subarray(0, 8))).toEqual([]);
  expect(framer.push(raw.subarray(8))).toEqual([frame]);
  expect(() => framer.push(new Uint8Array(513).fill(65))).toThrow();
  expect(Option.isNone(decodeHealth({ ...frame, mainSequence: 2 ** 53 }))).toBe(true);
});
it("requires an explicit channel mode and prevents descriptor collisions", () => {
  const base = {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
  };
  const decode = Schema.decodeUnknownOption(DesktopBackendBootstrap);
  expect(Option.isSome(decode(base))).toBe(true);
  expect(
    Option.isNone(
      decode({
        ...base,
        backendWatchdog: { protocol: 1, generation: "A", mode: "fd", healthFd: 4 },
      }),
    ),
  ).toBe(true);
  expect(
    Option.isSome(
      decode({ ...base, backendWatchdog: { protocol: 1, generation: "A", mode: "self-observer" } }),
    ),
  ).toBe(true);
});
