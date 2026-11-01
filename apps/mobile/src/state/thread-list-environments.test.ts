import { EnvironmentId, type ServerConfig, type SnoozePresetSetting } from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

function makeConfig(snoozePresets: ReadonlyArray<SnoozePresetSetting>): ServerConfig {
  return {
    providers: [],
    environment: { capabilities: { threadSnooze: true }, platform: { machine: "laptop" } },
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
});
