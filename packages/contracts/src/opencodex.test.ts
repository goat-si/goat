import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HostStatusMetrics } from "./hostStatus.ts";
import { OpenCodexInventorySnapshot } from "./opencodex.ts";

const decodeInventory = Schema.decodeUnknownSync(OpenCodexInventorySnapshot);
const decodeOptional = Schema.decodeUnknownSync(
  Schema.Struct({ opencodex: HostStatusMetrics.fields.opencodex }),
);

it("older host metrics omit OpenCodex and future unknown inventory cannot break host telemetry", () => {
  expect(decodeOptional({})).toEqual({});
  expect(
    decodeOptional({ opencodex: { installed: true, ownership: "future-ownership" } }).opencodex,
  ).toBeUndefined();
});

it("inventory round-trips served metadata while dropping private CLI fields", () => {
  const raw = {
    installed: true,
    ownership: "adopted",
    binaries: [{ path: "/fixture/ocx", version: "2.89.0" }],
    service: {
      available: true,
      installed: true,
      running: true,
      backend: "launchd",
      token: "fixture-private",
    },
    runtime: {
      healthy: true,
      ready: true,
      port: 10100,
      protocol: 1,
      minimumClientProtocol: 1,
      features: ["quota-pool/1"],
      token: "fixture-private",
    },
    link: { role: "home", available: true, links: [], childSettingsApplied: false },
    apiKey: "fixture-private",
  };
  const inventory = decodeInventory(raw);
  expect(inventory.runtime.protocol).toBe(1);
  expect(inventory.runtime.features).toEqual(["quota-pool/1"]);
  expect(JSON.stringify(inventory)).not.toContain("fixture-private");
  expect(decodeOptional({ opencodex: inventory }).opencodex).toEqual(inventory);
});
