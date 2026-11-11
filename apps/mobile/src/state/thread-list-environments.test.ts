import {
  EnvironmentId,
  type ServerConfig,
  type ServerProvider,
  type SnoozePresetSetting,
} from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

function makeConfig(
  snoozePresets: ReadonlyArray<SnoozePresetSetting>,
  overrides: {
    providers?: ReadonlyArray<ServerProvider>;
    capabilities?: Partial<ServerConfig["environment"]["capabilities"]>;
  } = {},
): ServerConfig {
  return {
    providers: overrides.providers ?? [],
    environment: {
      capabilities: overrides.capabilities ?? { threadSnooze: true },
      platform: { machine: "laptop" },
    },
    settings: { snoozePresets },
  } as unknown as ServerConfig;
}

describe("createThreadListEnvironmentsAtom", () => {
  it("publishes each environment's snooze presets and follows a change to only them", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const hour: ReadonlyArray<SnoozePresetSetting> = [{ kind: "after", minutes: 60 }];
    const evening: ReadonlyArray<SnoozePresetSetting> = [
      { kind: "at", day: "today", time: "18:00" },
    ];
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[environmentId, makeConfig(hour)]]),
    );
    const environments = createThreadListEnvironmentsAtom(configs, Atom.make([environmentId]));
    const registry = AtomRegistry.make();
    registry.mount(environments);
    try {
      expect(registry.get(environments).snoozePresetsByEnvironmentId.get(environmentId)).toEqual(
        hour,
      );
      const before = registry.get(environments);

      registry.set(configs, new Map([[environmentId, makeConfig([...hour])]]));
      expect(registry.get(environments)).toBe(before);

      registry.set(configs, new Map([[environmentId, makeConfig(evening)]]));
      expect(registry.get(environments).snoozePresetsByEnvironmentId.get(environmentId)).toEqual(
        evening,
      );
    } finally {
      registry.dispose();
    }
  });

  it("follows a provider whose execution location changes", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const provider = (executionLocation: "local" | "cloud"): ServerProvider =>
      ({
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        executionLocation,
      }) as unknown as ServerProvider;
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[environmentId, makeConfig([], { providers: [provider("local")] })]]),
    );
    const environments = createThreadListEnvironmentsAtom(configs, Atom.make([environmentId]));
    const registry = AtomRegistry.make();
    registry.mount(environments);
    try {
      expect(
        registry.get(environments).providersByEnvironmentId.get(environmentId)?.[0]
          ?.executionLocation,
      ).toBe("local");
      const before = registry.get(environments);

      registry.set(
        configs,
        new Map([[environmentId, makeConfig([], { providers: [provider("cloud")] })]]),
      );
      const after = registry.get(environments);
      expect(after).not.toBe(before);
      expect(after.providersByEnvironmentId.get(environmentId)?.[0]?.executionLocation).toBe(
        "cloud",
      );
    } finally {
      registry.dispose();
    }
  });

  it("follows the fork workspace capability", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[environmentId, makeConfig([])]]),
    );
    const environments = createThreadListEnvironmentsAtom(configs, Atom.make([environmentId]));
    const registry = AtomRegistry.make();
    registry.mount(environments);
    try {
      expect(registry.get(environments).forkWorkspaceEnvironmentIds.has(environmentId)).toBe(false);

      registry.set(
        configs,
        new Map([[environmentId, makeConfig([], { capabilities: { threadForkWorkspace: true } })]]),
      );
      expect(registry.get(environments).forkWorkspaceEnvironmentIds.has(environmentId)).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});
