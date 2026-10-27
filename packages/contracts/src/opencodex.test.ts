import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { HostStatusMetrics } from "./hostStatus.ts";
import { OpenCodexChildBootstrapStatus, OpenCodexInventorySnapshot } from "./opencodex.ts";
import {
  CHILD_READY_PROOF_TTL_MS,
  childReadyProofIsCurrent,
  decodeChildReadyConnectionInput,
  decodeChildReadyPrepareInput,
  decodeChildReadyResult,
} from "./opencodexChildReady.ts";

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

const decodeBootstrap = Schema.decodeUnknownSync(OpenCodexChildBootstrapStatus);
const encodeBootstrap = Schema.encodeSync(OpenCodexChildBootstrapStatus);
const childSetup = (proof: Record<string, unknown> | undefined) => ({
  version: 1,
  operationId: "op-1",
  destinationEnvironmentId: "child",
  homeEnvironmentId: "home",
  instanceId: "goat_ocx_0123456789abcdef01234567",
  revision: { epoch: "e", sequence: 3 },
  steps: [{ step: "inference_verified", state: "succeeded" }],
  readiness: "ready",
  attribution: "home_zero_local_accounts",
  nextAction: "none",
  ...(proof === undefined ? {} : { proof }),
});
const proof = {
  version: 1,
  operationId: "op-1",
  destinationEnvironmentId: "child",
  homeEnvironmentId: "home",
  instanceId: "goat_ocx_0123456789abcdef01234567",
  configFingerprint: "config",
  executablePath: "/fixture/codex",
  executableVersion: "0.156.1",
  linkId: "link-1",
  listenerInstanceId: "listener-1",
  settingsDigest: "settings",
  catalogDigest: "catalog",
  model: "fixture-model",
  completedAt: 1_000,
  expiresAt: 1_000 + CHILD_READY_PROOF_TTL_MS,
  attribution: "home_zero_local_accounts",
  localAccountsDigest: "zero",
};

it("round-trips Child Ready proof without treating legacy linked status as verified", () => {
  const ready = decodeBootstrap({ state: "child", checkedAt: 1, setup: childSetup(proof) });
  expect(decodeBootstrap(encodeBootstrap(ready))).toEqual(ready);
  expect(ready.setup?.proof && childReadyProofIsCurrent(ready.setup.proof, 2_000)).toBe(true);
  expect(
    ready.setup?.proof &&
      childReadyProofIsCurrent(ready.setup.proof, 1_000 + CHILD_READY_PROOF_TTL_MS),
  ).toBe(false);
  const legacy = decodeBootstrap({ state: "child", checkedAt: 1 });
  expect(legacy.setup).toBeUndefined();
  // A ready word without its proof is not Ready.
  const claimed = decodeBootstrap({ state: "child", checkedAt: 1, setup: childSetup(undefined) });
  expect(claimed.setup?.proof).toBeUndefined();
});

it("drops unknown Child setup versions without discarding host telemetry", () => {
  const status = decodeBootstrap({
    state: "child",
    checkedAt: 1,
    version: "2.92.0",
    step: "future_step",
    setup: { ...childSetup(proof), version: 2 },
    nextAction: "future_action",
  });
  expect(status).toEqual({ state: "child", checkedAt: 1, version: "2.92.0" });
});

it("rejects unknown Child prepare actions before dispatch", async () => {
  const address = {
    destinationEnvironmentId: EnvironmentId.make("child"),
    homeEnvironmentId: EnvironmentId.make("home"),
    operationId: "op-1",
  };
  for (const action of ["installEverything", "status"])
    await expect(
      Effect.runPromise(decodeChildReadyPrepareInput({ ...address, action })),
    ).rejects.toThrow();
  // An older Child's untyped answer is not a device result.
  await expect(
    Effect.runPromise(decodeChildReadyResult({ kind: "device", ...address, healthy: true })),
  ).rejects.toThrow();
});

it("prepare rejects connection operations and accepts only its seven setup actions", async () => {
  const address = {
    destinationEnvironmentId: EnvironmentId.make("j2-child"),
    homeEnvironmentId: EnvironmentId.make("j2-home"),
    operationId: "j2-operation",
  };
  const connection = { kind: "disconnect", expectedLinkId: "j2-link" };
  for (const input of [
    { ...address, action: "opencodexConnection", opencodexConnection: connection },
    { ...address, action: "installOpenCodex", opencodexConnection: connection },
  ])
    await expect(Effect.runPromise(decodeChildReadyPrepareInput(input))).rejects.toThrow();
  expect(
    await Effect.runPromise(
      decodeChildReadyConnectionInput({ ...address, opencodexConnection: connection }),
    ),
  ).toEqual({ ...address, opencodexConnection: connection });
  for (const action of [
    "installOpenCodex",
    "startOpenCodex",
    "opencodexHealth",
    "installCodex",
    "syncCatalog",
    "configure",
    "probe",
  ])
    expect(await Effect.runPromise(decodeChildReadyPrepareInput({ ...address, action }))).toEqual({
      ...address,
      action,
    });
});
