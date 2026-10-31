// @effect-diagnostics nodeBuiltinImport:off - Reads server source to inventory settings writers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { SETTINGS_ACCESS } from "@goat/contracts/agentSurface";

const SERVER_SOURCE = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every server file that writes settings directly, and why. A setting agents may change goes
 * through goat_environment_settings_update and SETTINGS_ACCESS; a new writer belongs here only
 * when it performs a transition beyond storing a value (docs/internals/agent-surface.md#settings).
 */
const SETTINGS_WRITERS: Readonly<Record<string, string>> = {
  "auth/SettingsRpc.ts": "The Settings page's update RPC, authorized again at commit.",
  "mcp/toolkits/environment/handlers.ts": "The agent settings paths.",
  "channels/ChannelBotHome.ts": "Claims GOAT Bot's home; a newer claim wins.",
  "goatclaw/FleetSync.ts": "Exchanges the goatclaw policy between hosts.",
  "fleet/resources/Fallback.ts": "Validates and stores fallback chains.",
  "device/DeviceService.ts": "Stores device hosts after checking them.",
  "cua/ComputerUseSettings.ts": "Turns computer use on after admission.",
  "handoffs/computerUseStanding.ts":
    "Records a person's standing app choice when an authorized computer-use handoff completes.",
  "mcp/ThreadReplicaService.ts": "Sets checkpoint replication for a host.",
  "memory/MemorySettingsService.ts": "Versioned memory settings transitions.",
  "provider/ProjectSettingsOverrideSweep.ts": "Removes overrides for deleted provider instances.",
  "project/ProjectService.ts": "Keeps project overrides in step with project records.",
};

const isTestSource = (file: string) =>
  /\.test\.ts$|test-cases\.ts$|testkit/.test(file.replaceAll("\\", "/"));

function serverSources(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return serverSources(path);
    return entry.name.endsWith(".ts") && !isTestSource(path) ? [path] : [];
  });
}

it("adds no direct settings writer without a reviewed reason", () => {
  const writers = serverSources(SERVER_SOURCE)
    .filter((file) => /\.updateSettings(With)?\(/.test(NodeFS.readFileSync(file, "utf8")))
    .map((file) => NodePath.relative(SERVER_SOURCE, file).replaceAll("\\", "/"))
    .sort();
  expect(writers).toEqual(Object.keys(SETTINGS_WRITERS).sort());
});

it("keeps allowed-app grants person-only and confines named writers to computer-use paths", () => {
  expect(SETTINGS_ACCESS.cuaAllowedApps.access).toBe("person");
  const namedWriters = Object.keys(SETTINGS_WRITERS).filter((file) =>
    /cuaAllowedApps/.test(NodeFS.readFileSync(NodePath.join(SERVER_SOURCE, file), "utf8")),
  );
  expect(namedWriters.sort()).toEqual([
    "cua/ComputerUseSettings.ts",
    "handoffs/computerUseStanding.ts",
  ]);
});
