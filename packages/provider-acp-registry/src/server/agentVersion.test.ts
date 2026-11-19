import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "../settings.ts";
import { buildCheckedAcpRegistrySnapshot } from "./driver.ts";
import { acpRegistryProbeResult } from "./probe.ts";

it("shows the bounded reported version only for a local ACP executable", () => {
  const instanceId = ProviderInstanceId.make("acpRegistry_version");
  const probe = acpRegistryProbeResult(instanceId, {
    sessionId: "test-session",
    initializeResult: { protocolVersion: 1, agentInfo: { name: "Example", version: " 1.5.9 " } },
    sessionSetupResult: {},
    modelConfigId: undefined,
  });
  const decode = Schema.decodeSync(AcpRegistrySettings);
  const input = {
    instanceId,
    displayName: undefined,
    accentColor: undefined,
    continuationKey: "acpRegistry:version",
    checkedAt: "2026-01-01T00:00:00.000Z",
    probe: { probe, slashCommands: [], skills: [] },
  };
  const local = buildCheckedAcpRegistrySnapshot({
    ...input,
    settings: decode({ source: "local", commandPath: "example" }),
    inspection: { status: "ready", agentId: "example", version: null, distribution: "local" },
  });
  expect(local.version).toBe("1.5.9");
  const managed = buildCheckedAcpRegistrySnapshot({
    ...input,
    settings: decode({ agentId: "example" }),
    inspection: { status: "ready", agentId: "example", version: "2.0.0", distribution: "npx" },
  });
  expect(managed.version).toBe("2.0.0");
});

it("treats blank and control characters as absent and caps long reports", () => {
  const instanceId = ProviderInstanceId.make("acpRegistry_version");
  const makeProbe = (version: string | undefined) =>
    acpRegistryProbeResult(instanceId, {
      sessionId: "test-session",
      initializeResult: {
        protocolVersion: 1,
        ...(version === undefined ? {} : { agentInfo: { name: "Example", version } }),
      },
      sessionSetupResult: {},
      modelConfigId: undefined,
    });
  expect(makeProbe(undefined).agentVersion).toBeUndefined();
  expect(makeProbe("  ").agentVersion).toBeUndefined();
  expect(makeProbe("v1\nspoof").agentVersion).toBeUndefined();
  expect(makeProbe("x".repeat(80)).agentVersion).toBe("x".repeat(64));
});
