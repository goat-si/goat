import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  it("makes implicit cloud slots follow their siblings", () => {
    const cursor = ProviderInstanceId.make("cursor");
    const cursorCloud = ProviderInstanceId.make("cursorCloud");
    const claudeCloud = ProviderInstanceId.make("claudeCloud");
    const off = deriveProviderInstanceConfigMap(settingsWith({}));
    expect(off[cursorCloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: false,
    });
    expect(off[claudeCloud]).toEqual({
      driver: ProviderDriverKind.make("claudeCloud"),
      enabled: true,
    });

    const on = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
        },
      }),
    );
    expect(on[cursorCloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: true,
    });
    expect(
      deriveProviderInstanceConfigMap(
        settingsWith({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
          },
        }),
      )[claudeCloud]?.enabled,
    ).toBe(false);
  });

  it("omits a cloud default when an explicit custom-id cloud instance exists", () => {
    const custom = ProviderInstanceId.make("cursorCloud_work");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [custom]: { driver: ProviderDriverKind.make("cursorCloud"), enabled: true },
        },
      }),
    );
    expect(merged[ProviderInstanceId.make("cursorCloud")]).toBeUndefined();
    expect(merged[custom]?.enabled).toBe(true);
  });

  it("preserves an explicit disabled cloud default even with an enabled sibling", () => {
    const cloud = ProviderInstanceId.make("cursorCloud");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("cursor")]: {
            driver: ProviderDriverKind.make("cursor"),
            enabled: true,
          },
          [cloud]: { driver: ProviderDriverKind.make("cursorCloud"), enabled: false },
        },
      }),
    );
    expect(merged[cloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: false,
    });
  });

  it("enables Devin Cloud only with an enabled Devin ACP instance", () => {
    const devinCloud = ProviderInstanceId.make("devinCloud");
    const acpInstance = ProviderInstanceId.make("devin_acp");
    const acpDriver = ProviderDriverKind.make("acpRegistry");
    const without = deriveProviderInstanceConfigMap(settingsWith({}));
    expect(without[devinCloud]).toEqual({
      driver: ProviderDriverKind.make("devinCloud"),
      enabled: false,
    });

    const withDisabled = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [acpInstance]: { driver: acpDriver, enabled: false, config: { agentId: "devin" } },
        },
      }),
    );
    expect(withDisabled[devinCloud]?.enabled).toBe(false);

    const withEnabled = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [acpInstance]: { driver: acpDriver, enabled: true, config: { agentId: "devin" } },
        },
      }),
    );
    expect(withEnabled[devinCloud]?.enabled).toBe(true);
  });

  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("leaves an already machine-enabled instance untouched", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });

  it("folds overrides from multiple projects", () => {
    const otherInstanceId = ProviderInstanceId.make("claudeAgent_personal");
    const otherProjectId = ProjectId.make("project-b");
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        [otherInstanceId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        [otherProjectId]: { providerInstances: { [otherInstanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
    expect(merged[otherInstanceId]).toEqual({
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
    });
  });
});
