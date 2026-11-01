import {
  EnvironmentId,
  ProviderInstanceId,
  type ChildReadyProof,
  type HostStatusEntry,
  type HubNode,
  type OpenCodexChildBootstrapStatus,
  type OpenCodexChildSetup,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  connectHubProxySaveError,
  cloudAutoJoinSaveError,
  hubDeviceList,
  presentChildSetup,
} from "./hubDevices.ts";
import type { HubDevice, HubSnapshot } from "./state/hubFleet.ts";

function node(
  nodeId: string,
  label: string,
  targets: ReadonlyArray<HubNode["routes"][number]["target"]>,
): HubNode {
  return {
    nodeId,
    environmentId: null,
    label,
    kind: targets[0]!.kind,
    routes: targets.map((target) => ({
      routeId: `${target.kind}:${target.kind === "linked" ? target.name : target.alias}`,
      source: target.kind === "cloud" ? "cloud-machine" : "registered",
      target,
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    })),
    status: "online",
    lastSeenAt: null,
    addedBy: null,
  } as HubNode;
}

const ssh = (alias: string) =>
  ({ kind: "ssh", alias, hostname: null, username: null, port: null }) as const;
const cloud = (alias: string) => ({ kind: "cloud", alias }) as HubNode["routes"][number]["target"];

function device(alias: string, transport: HubDevice["transport"] = "remote-link"): HubDevice {
  return {
    alias,
    transport,
    reachability: "ok",
    tunnel: transport === "remote-link" ? "connected" : null,
    parity: null,
    version: "2.89.0",
    versionVerdict: "compatible",
    fallback: "unknown",
    pressure: null,
  };
}

function snapshot(devices: ReadonlyArray<HubDevice>): HubSnapshot {
  return { homeName: "jun-mbp", homeVersion: "2.89.0", homeHealthy: true, homeKey: "", devices };
}

function host(
  alias: string,
  opencodexChild?: OpenCodexChildBootstrapStatus,
  opencodexChildOptIn?: boolean,
): HostStatusEntry {
  return {
    host: alias,
    reachability: "ok",
    ...(opencodexChild === undefined ? {} : { opencodexChild }),
    ...(opencodexChildOptIn === undefined ? {} : { opencodexChildOptIn }),
  };
}

describe("presentChildSetup", () => {
  it("names the reason and keeps the Home's message for each unfinished state", () => {
    expect(presentChildSetup({ state: "running", checkedAt: 1 })).toMatchObject({
      state: "running",
      tone: "progress",
      label: "Setting up as OpenCodex Child",
      detail: null,
      checkedAt: 1,
    });
    expect(
      presentChildSetup({
        state: "blocked",
        reason: "npm_missing",
        message: "npm is not on the machine's PATH.",
        checkedAt: 2,
      }),
    ).toMatchObject({
      tone: "destructive",
      label: "OpenCodex Child setup blocked: npm missing",
      detail: "npm is not on the machine's PATH.",
    });
    expect(
      presentChildSetup({ state: "degraded", message: "Parity P5 failed.", checkedAt: 3 }),
    ).toMatchObject({ tone: "warning", label: "OpenCodex Child degraded" });
  });

  it("says nothing once the machine is a Child or when an older Home sent no status", () => {
    expect(presentChildSetup({ state: "child", checkedAt: 1 })).toBeNull();
    expect(presentChildSetup(undefined)).toBeNull();
  });

  it("labels a timed-out setup step with its retry guidance instead of an undefined reason", () => {
    const setup = presentChildSetup({
      state: "blocked",
      reason: "setup_step_timeout",
      checkedAt: 1,
    });
    expect(setup?.label).toBe(
      "OpenCodex Child setup blocked: A setup step timed out. Retry setup.",
    );
    expect(setup?.label).not.toContain("undefined");
  });

  it("explains that GOAT installs its runtime before retrying Child setup", () => {
    expect(
      presentChildSetup({
        state: "blocked",
        reason: "goat_runtime_missing",
        message: "GOAT's runtime is not available there. Finish SSH setup and retry.",
        checkedAt: 2,
      }),
    ).toMatchObject({
      state: "blocked",
      tone: "destructive",
      label:
        "OpenCodex Child setup blocked: GOAT isn't installed there yet; GOAT installs it first, then retries",
      detail: "GOAT's runtime is not available there. Finish SSH setup and retry.",
    });
  });
});

describe("hubDeviceList", () => {
  it("joins a hub node and its OpenCodex device into one row and keeps machines only one side knows", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "Mac mini", [ssh("macmini-ts")]), node("n2", "lidge", [ssh("lidge-ts")])],
      snapshot: snapshot([device("macmini-ts"), device("studio-ts", "standalone")]),
      hosts: [],
    });
    expect(
      rows.map((row) => [row.key, row.node?.nodeId ?? null, row.device?.alias ?? null]),
    ).toEqual([
      ["node:n1", "n1", "macmini-ts"],
      ["node:n2", "n2", null],
      ["device:studio-ts", null, "studio-ts"],
    ]);
  });

  it("prefers a route alias over a label that equals another machine's alias", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "lidge-ts", [ssh("other")]), node("n2", "Lidge", [ssh("lidge-ts")])],
      snapshot: snapshot([device("lidge-ts")]),
      hosts: [],
    });
    expect(rows.find((row) => row.device !== null)?.node?.nodeId).toBe("n2");
    expect(rows).toHaveLength(2);
  });

  it("lets a node's route alias win over its own label whatever order the devices come in", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "label-name", [ssh("route-name")])],
      snapshot: snapshot([device("label-name"), device("route-name")]),
      hosts: [],
    });
    expect(rows.map((row) => [row.key, row.device?.alias ?? null])).toEqual([
      ["node:n1", "route-name"],
      ["device:label-name", "label-name"],
    ]);
  });

  it("puts each machine's setup on one row only, the one whose route names it", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "boat-2", [cloud("boat-1")]), node("n2", "second", [cloud("boat-2")])],
      snapshot: null,
      hosts: [host("boat-2", { state: "running", checkedAt: 1 })],
    });
    expect(rows.map((row) => [row.key, row.childSetup?.state ?? null])).toEqual([
      ["node:n1", null],
      ["node:n2", "running"],
    ]);
  });

  it("shows the Home's setup on the cloud machine's row, and alone when nothing else lists it", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "boat-1", [cloud("boat-1")])],
      snapshot: null,
      hosts: [
        host("boat-1", { state: "blocked", reason: "npm_missing", checkedAt: 1 }),
        host("boat-2", { state: "running", checkedAt: 1 }),
        host("boat-3", { state: "child", checkedAt: 1 }),
        host("macmini-ts"),
      ],
    });
    expect(rows.map((row) => [row.key, row.childSetup?.label ?? null])).toEqual([
      ["node:n1", "OpenCodex Child setup blocked: npm missing"],
      ["setup:boat-2", "Setting up as OpenCodex Child"],
      // A linked machine stays listed: linked is not the same as Codex verified through Home.
      ["setup:boat-3", "Linked · Codex not verified"],
    ]);
  });

  it("still lists OpenCodex devices when the hub cannot list its nodes", () => {
    const rows = hubDeviceList({
      nodes: null,
      snapshot: snapshot([device("macmini-ts")]),
      hosts: [],
    });
    expect(rows.map((row) => row.key)).toEqual(["device:macmini-ts"]);
  });

  it("offers the Child setup switch only for SSH hosts the hub says it can join", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "Mac mini", [ssh("macmini-ts")])],
      snapshot: null,
      hosts: [
        host("macmini-ts", undefined, true),
        host("lidge-ts", undefined, false),
        // An older hub sends no switch for its hosts, so none is offered.
        host("studio-ts"),
      ],
    });
    expect(rows.map((row) => [row.key, row.childOptIn])).toEqual([
      ["node:n1", { host: "macmini-ts", enabled: true }],
      ["setup:lidge-ts", { host: "lidge-ts", enabled: false }],
    ]);
  });

  it("says why an SSH host's Child setup was turned off", () => {
    const rows = hubDeviceList({
      nodes: null,
      snapshot: null,
      hosts: [
        host(
          "lidge-ts",
          {
            state: "blocked",
            reason: "consent_revoked",
            message: "Turn it on again.",
            checkedAt: 1,
          },
          false,
        ),
      ],
    });
    expect(rows[0]).toMatchObject({
      childOptIn: { host: "lidge-ts", enabled: false },
      childSetup: {
        label:
          "OpenCodex Child setup blocked: turned off because the session that allowed it lost access",
        detail: "Turn it on again.",
      },
    });
  });
});

describe("cloudAutoJoinSaveError", () => {
  it("flags an older hub that kept joining cloud machines after the switch was turned off", () => {
    expect(cloudAutoJoinSaveError(false, true)).toMatch(/older GOAT/);
    expect(cloudAutoJoinSaveError(false, false)).toBeNull();
    expect(cloudAutoJoinSaveError(true, true)).toBeNull();
  });
});

it("requires a hub upgrade when an older server silently drops Connect consent", () => {
  expect(connectHubProxySaveError(true, undefined)).toMatch(/Update GOAT on the hub/);
  expect(connectHubProxySaveError(true, false)).toMatch(/Update GOAT/);
  expect(connectHubProxySaveError(false, undefined)).toBeNull();
  expect(connectHubProxySaveError(true, true)).toBeNull();
});

function childSetupFixture(overrides: Partial<OpenCodexChildSetup> = {}): OpenCodexChildSetup {
  return {
    version: 1,
    operationId: "setup-1",
    destinationEnvironmentId: EnvironmentId.make("test-child-env"),
    homeEnvironmentId: EnvironmentId.make("test-home-env"),
    instanceId: ProviderInstanceId.make("child-codex"),
    revision: { epoch: "test-epoch", sequence: 1 },
    steps: [],
    readiness: "linked",
    attribution: "home_zero_local_accounts",
    nextAction: "retry",
    ...overrides,
  };
}

function childProofFixture(overrides: Partial<ChildReadyProof> = {}): ChildReadyProof {
  const setup = childSetupFixture();
  return {
    version: 1,
    operationId: setup.operationId,
    destinationEnvironmentId: setup.destinationEnvironmentId,
    homeEnvironmentId: setup.homeEnvironmentId,
    instanceId: setup.instanceId,
    configFingerprint: "config-1",
    executablePath: "/test/bin/codex",
    executableVersion: "test-version",
    linkId: "test-link",
    listenerInstanceId: "test-listener",
    linkConnectionGeneration: "test-generation",
    settingsDigest: "settings-1",
    catalogDigest: "catalog-1",
    model: "home-model",
    completedAt: 0,
    expiresAt: 86_400_000,
    attribution: "home_zero_local_accounts",
    localAccountsDigest: "empty-local-accounts",
    ...overrides,
  };
}

const readySetup = (overrides: Partial<OpenCodexChildSetup> = {}) =>
  childSetupFixture({
    readiness: "ready",
    nextAction: "none",
    steps: [{ step: "inference_verified", state: "succeeded" }],
    proof: childProofFixture(),
    ...overrides,
  });

describe("Hub Child readiness", () => {
  const child = (status: OpenCodexChildBootstrapStatus) =>
    hubDeviceList({ nodes: null, snapshot: null, hosts: [host("test-child", status)] })[0]
      ?.childSetup;

  it("keeps a linked Child listed as unverified and offers Continue setup on its SSH alias", () => {
    expect(child({ state: "child", checkedAt: 1 })).toMatchObject({
      label: "Linked · Codex not verified",
      tone: "warning",
      proof: null,
      host: "test-child",
      nextAction: "continue_setup",
      actionable: true,
    });
  });

  it("shows Ready only for a current proof of a request the Child made through Home", () => {
    expect(child({ state: "child", checkedAt: 1, setup: readySetup() })).toMatchObject({
      label: "Ready",
      tone: "success",
      proof: { model: "home-model", completedAt: 0 },
      nextAction: "none",
      actionable: false,
    });
    expect(child({ state: "degraded", checkedAt: 1, setup: readySetup() })).not.toHaveProperty(
      "label",
      "Ready",
    );
  });

  it.each([
    ["the proof has expired", { checkedAt: 86_400_000 }, {}],
    ["Home attribution is unproven", {}, { attribution: "unproven" as const }],
  ])("withholds Ready when %s", (_case, status, setup) => {
    expect(
      child({ state: "child", checkedAt: 1, ...status, setup: readySetup(setup) }),
    ).toMatchObject({ label: "Linked · Codex not verified", proof: null });
  });

  it("withholds Ready and offers Continue setup when the Home kept no proof", () => {
    const { proof: _proof, ...unproven } = readySetup();
    expect(child({ state: "child", checkedAt: 1, setup: unproven })).toMatchObject({
      label: "Linked · Codex not verified",
      proof: null,
      nextAction: "retry",
      actionable: true,
    });
  });

  it("withholds Ready and every action after the latest status read failed", () => {
    const rows = hubDeviceList({
      nodes: null,
      snapshot: null,
      hosts: [host("test-child", { state: "child", checkedAt: 1, setup: readySetup() })],
      statusCurrent: false,
    });
    expect(rows[0]?.childSetup).toMatchObject({
      label: "Setup status unavailable. Refresh status.",
      proof: null,
      nextAction: "none",
      actionable: false,
    });
  });

  it.each([
    { operationId: "older-setup" },
    { destinationEnvironmentId: EnvironmentId.make("other-child") },
    { homeEnvironmentId: EnvironmentId.make("other-home") },
    { instanceId: ProviderInstanceId.make("other-instance") },
  ])("withholds Ready for a proof bound to another setup: %o", (mismatch) => {
    expect(
      child({
        state: "child",
        checkedAt: 1,
        setup: readySetup({ proof: childProofFixture(mismatch) }),
      }),
    ).toMatchObject({ label: "Linked · Codex not verified", proof: null });
  });

  it.each(["pending", "running", "failed"] as const)(
    "withholds Ready when a reported step is %s beside an older proof",
    (state) => {
      expect(
        child({
          state: "child",
          checkedAt: 1,
          setup: readySetup({ steps: [{ step: "inference_verified", state }] }),
        }),
      ).toMatchObject({ proof: null });
    },
  );

  it("names the running step and keeps pending steps pending", () => {
    expect(
      child({
        state: "child",
        checkedAt: 1,
        setup: childSetupFixture({
          readiness: "verifying",
          nextAction: "none",
          steps: [
            { step: "codex_installed", state: "succeeded" },
            { step: "instance_routed", state: "running" },
            { step: "inference_verified", state: "pending" },
          ],
        }),
      }),
    ).toMatchObject({
      label: "Route Codex through Home…",
      tone: "progress",
      steps: [
        { label: "Install Codex", outcome: "succeeded" },
        { label: "Route Codex through Home", outcome: "running" },
        { label: "Verify a request through Home", outcome: "pending" },
      ],
    });
  });

  it("names the failed step and keeps the server's recovery action", () => {
    expect(
      child({
        state: "child",
        checkedAt: 1,
        setup: childSetupFixture({
          readiness: "invalid",
          nextAction: "review_settings",
          steps: [
            { step: "codex_installed", state: "succeeded" },
            { step: "instance_routed", state: "failed" },
          ],
          failure: {
            code: "stale_configuration",
            step: "instance_routed",
            message: "The instance changed. Review settings.",
            retryable: false,
          },
        }),
      }),
    ).toMatchObject({
      tone: "destructive",
      detail: "The instance changed. Review settings.",
      nextAction: "review_settings",
      actionable: false,
    });
  });

  it("offers update guidance only for the server's typed remote_outdated refusal", () => {
    const refusal = {
      code: "remote_outdated" as const,
      step: "goat_available" as const,
      message: "Update GOAT on this Child, then continue setup.",
      retryable: false,
    };
    expect(
      child({
        state: "child",
        checkedAt: 1,
        nextAction: "update_goat",
        actionable: false,
        failure: refusal,
      }),
    ).toMatchObject({
      nextAction: "update_goat",
      actionable: false,
      detail: "Update GOAT on this Child, then continue setup.",
    });
    // Without the typed refusal, a bare update action is not evidence of an older GOAT.
    expect(child({ state: "child", checkedAt: 1, nextAction: "update_goat" })).toMatchObject({
      nextAction: "none",
      actionable: false,
    });
    expect(
      child({
        state: "child",
        checkedAt: 1,
        setup: childSetupFixture({ nextAction: "update_goat" }),
      }),
    ).toMatchObject({ nextAction: "update_goat", actionable: false });
  });

  it("lets nested setup supersede an older outer refusal and honors a non-actionable outer action", () => {
    expect(
      child({
        state: "child",
        checkedAt: 1,
        nextAction: "update_goat",
        actionable: false,
        failure: {
          code: "remote_outdated",
          step: "goat_available",
          message: "Old refusal.",
          retryable: false,
        },
        setup: childSetupFixture({
          nextAction: "retry",
          failure: {
            code: "probe_failed",
            step: "inference_verified",
            message: "Retry verification.",
            retryable: true,
          },
        }),
      }),
    ).toMatchObject({ nextAction: "retry", actionable: true, detail: "Retry verification." });
    expect(
      child({ state: "child", checkedAt: 1, nextAction: "continue_setup", actionable: false }),
    ).toMatchObject({ nextAction: "continue_setup", actionable: false });
    expect(
      child({ state: "degraded", checkedAt: 1, nextAction: "reconnect_home", actionable: true }),
    ).toMatchObject({ nextAction: "reconnect_home", actionable: true });
  });
});
