import {
  MemoryHubSettings,
  MemoryHubSettingsUpdateInput,
  ORCHESTRATION_HISTORY_BUDGET_BYTES,
  ORCHESTRATION_HISTORY_ARCHIVE_AFTER_DAYS,
} from "./memory.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { DEFAULT_OPENCODEX_BASE_URL } from "./codexRoute.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInstanceMutation,
} from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  CodexSettings,
  ServerSettingsError,
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  implicitDefaultInstance,
  isDevinAcpRegistryInstance,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  requiredScopesForServerSettingsPatch,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
      historyBudgetBytes: ORCHESTRATION_HISTORY_BUDGET_BYTES,
      historyArchiveAfterDays: ORCHESTRATION_HISTORY_ARCHIVE_AFTER_DAYS,
      historyArchiveDeleteAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to pill and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("pill");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to Projects view", () => {
    expect(decodeClientSettings({}).legacySidebarEnabled).toBe(true);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(true);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it.each([true, false])("preserves an explicit sidebar view choice: %s", (value) => {
    expect(decodeClientSettings({ legacySidebarEnabled: value }).legacySidebarEnabled).toBe(value);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: value }).legacySidebarEnabled).toBe(
      value,
    );
  });
});

describe("ClientSettings context window meter", () => {
  it("shows by default, even for settings persisted with the old default-off flag", () => {
    expect(decodeClientSettings({}).contextWindowMeterHidden).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: false }).contextWindowMeterHidden,
    ).toBe(false);
  });

  it("preserves an explicit opt-out", () => {
    expect(decodeClientSettings({ contextWindowMeterHidden: true }).contextWindowMeterHidden).toBe(
      true,
    );
    expect(
      decodeClientSettingsPatch({ contextWindowMeterHidden: true }).contextWindowMeterHidden,
    ).toBe(true);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("branch naming settings", () => {
  it("defaults missing settings to the GOAT static prefix", () => {
    expect(decodeServerSettings({})).toMatchObject({
      branchNamingMode: "static",
      branchNamePrefix: "goat",
      branchNameInstructions: "",
    });
  });
  it("preserves an explicitly saved legacy prefix", () => {
    expect(decodeServerSettings({ branchNamePrefix: "t3" }).branchNamePrefix).toBe("t3"); // goat-rename: legacy
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("implicitDefaultInstance", () => {
  const cursor = ProviderInstanceId.make("cursor");
  const cursorCloud = ProviderInstanceId.make("cursorCloud");
  const cloudDriver = ProviderDriverKind.make("cursorCloud");

  it("follows the effective sibling state and project resolution", () => {
    const off = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {} };
    expect(implicitDefaultInstance(off, cloudDriver)).toEqual({ present: true, enabled: false });
    expect(resolveProjectProviderInstanceEnabled(off, null, cursorCloud)).toBe(false);

    const on = {
      ...off,
      providerInstances: { [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true } },
    };
    expect(implicitDefaultInstance(on, cloudDriver)).toEqual({ present: true, enabled: true });
    expect(resolveProjectProviderInstanceEnabled(on, null, cursorCloud)).toBe(true);
  });

  it("suppresses the implicit cloud slot for a custom-id cloud instance", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("cursor_cloud_work")]: { driver: cloudDriver, enabled: true },
      },
    };
    expect(implicitDefaultInstance(settings, cloudDriver)).toEqual({
      present: false,
      enabled: false,
    });
    expect(resolveProjectProviderInstanceEnabled(settings, null, cursorCloud)).toBe(false);
  });

  it("honors an explicit default-id disable ahead of sibling enablement", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
        [cursorCloud]: { driver: cloudDriver, enabled: false },
      },
    };
    expect(implicitDefaultInstance(settings, cloudDriver).present).toBe(false);
    expect(resolveProjectProviderInstanceEnabled(settings, null, cursorCloud)).toBe(false);
  });

  it("enables Devin Cloud only for an enabled Devin ACP instance", () => {
    const driver = ProviderDriverKind.make("devinCloud");
    const acp = ProviderDriverKind.make("acpRegistry");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("devin")]: {
          driver: acp,
          enabled: true,
          config: { agentId: "devin" },
        },
      },
    };
    expect(implicitDefaultInstance(settings, driver)).toEqual({ present: true, enabled: true });
    expect(
      implicitDefaultInstance(
        {
          ...settings,
          providerInstances: {
            ...settings.providerInstances,
            [ProviderInstanceId.make("devin")]: {
              driver: acp,
              enabled: false,
              config: { agentId: "devin" },
            },
          },
        },
        driver,
      ).enabled,
    ).toBe(false);
  });

  it("treats a local devin command as a Devin ACP instance", () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    expect(
      isDevinAcpRegistryInstance({
        driver: acp,
        config: { source: "local", commandPath: "/opt/bin/devin" },
      }),
    ).toBe(true);
    expect(
      isDevinAcpRegistryInstance({
        driver: acp,
        config: { source: "local", commandPath: "/bin/sh" },
      }),
    ).toBe(false);
    expect(
      isDevinAcpRegistryInstance({ driver: acp, config: { agentId: "devin", enabled: false } }),
    ).toBe(false);
  });

  it("ignores a project override for a cloud slot that does not run", () => {
    const projectId = "project-1" as ProjectId;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
        [ProviderInstanceId.make("cursor_cloud_work")]: { driver: cloudDriver, enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [cursorCloud]: { enabled: true } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, cursorCloud)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("memory hub settings", () => {
  it("defaults old settings to disabled memory hub", () => {
    expect(decodeServerSettings({}).memoryHub).toEqual({ mode: "disabled" });
    expect(decodeServerSettings({}).memoryHubVersion).toBe(0);
  });
  it("round-trips hub and member without secret bytes", () => {
    for (const memoryHub of [
      { mode: "hub", memorySpaceId: null },
      {
        mode: "member",
        hubEnvironmentId: "env",
        endpoint: "https://hub.invalid",
        secretName: "memory-hub-member",
        memorySpaceId: null,
      },
    ])
      expect(encodeServerSettings(decodeServerSettings({ memoryHub }))).toMatchObject({
        memoryHub,
      });
  });
  it("rejects credentials query and nonloopback plain HTTP in hub endpoint", () => {
    for (const endpoint of [
      "https://user:pass@hub.invalid",
      "https://hub.invalid?x=y",
      "http://hub.invalid",
      "https://hub.invalid/path",
      "https://hub.invalid#secret",
    ])
      expect(() =>
        Schema.decodeUnknownSync(MemoryHubSettings)({
          mode: "member",
          hubEnvironmentId: "env",
          endpoint,
          secretName: "memory-hub-member",
          memorySpaceId: null,
        }),
      ).toThrow();
  });
  it("replaces memory hub configuration as one dedicated admin field", () => {
    expect(
      Schema.decodeUnknownSync(MemoryHubSettingsUpdateInput)({
        requestId: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 0,
        action: "configure",
        settings: { mode: "disabled" },
      }),
    ).toMatchObject({ settings: { mode: "disabled" } });
    expect(() =>
      Schema.decodeUnknownSync(MemoryHubSettings)({
        mode: "disabled",
        endpoint: "https://old.invalid",
      }),
    ).toThrow();
  });
  it("rejects reserved memoryHub in generic settings patch", () => {
    for (const raw of [
      { memoryHub: { mode: "disabled" } },
      { memoryHubVersion: 1 },
      { standingInstructions: "valid", memoryHub: { mode: "disabled" } },
      { standingInstructions: "valid", memoryHubVersion: 1 },
    ])
      expect(() => decodeServerSettingsPatch(raw)).toThrow();
    expect(decodeServerSettingsPatch({ standingInstructions: "valid", futureField: 1 })).toEqual({
      standingInstructions: "valid",
    });
  });
});

describe("managed memory settings", () => {
  it("defaults installed agent memory on and owner source reads to an empty policy", () => {
    const settings = decodeServerSettings({});
    expect(settings.enableAgentMemoryAccess).toBe(true);
    expect(settings.memoryOwnerSourceReadPolicy).toEqual({
      allowedRequesterEnvironmentIds: [],
      ownerPolicyEpoch: 0,
      removals: [],
      enrollments: [],
    });
    expect(settings.memoryOwnerSourceReadPolicyVersion).toBe(0);
    expect(decodeServerSettings(encodeServerSettings(settings))).toEqual(settings);
  });
  it("round-trips memory off and guards both on/off updates with settings write", () => {
    expect(decodeServerSettings({ enableAgentMemoryAccess: false }).enableAgentMemoryAccess).toBe(
      false,
    );
    expect(decodeServerSettingsPatch({ enableAgentMemoryAccess: false })).toEqual({
      enableAgentMemoryAccess: false,
    });
    for (const enabled of [true, false])
      expect(requiredScopesForServerSettingsPatch({ enableAgentMemoryAccess: enabled })).toEqual([
        "settings:write",
      ]);
    expect(() => decodeServerSettingsPatch({ enableAgentMemoryAccess: "on" })).toThrow();
    for (const key of ["memoryOwnerSourceReadPolicy", "memoryOwnerSourceReadPolicyVersion"])
      expect(() =>
        decodeServerSettingsPatch({ [key]: key.endsWith("Version") ? 0 : {} }),
      ).toThrow();
  });
});

it("keeps process-neutral memory disabled and reserves automatic provenance from settings patches", () => {
  const decoded = decodeServerSettings({});
  expect(decoded.memoryHub).toEqual({ mode: "disabled" });
  expect(decoded).not.toHaveProperty("memoryHubProvenance");
  expect(() => decodeServerSettingsPatch({ memoryHubProvenance: null })).toThrow();
});

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const mutationCodec = Schema.toCodecJson(ProviderInstanceMutation);
const decodeInstanceMutation = Schema.decodeUnknownSync(mutationCodec);
const encodeInstanceMutation = Schema.encodeSync(mutationCodec);
const settingsErrorCodec = Schema.toCodecJson(ServerSettingsError);
const decodeSettingsError = Schema.decodeUnknownSync(settingsErrorCodec);
const encodeSettingsError = Schema.encodeSync(settingsErrorCodec);

describe("OpenCodex Home routing", () => {
  it("decodes legacy Codex settings as default", () => {
    expect(decodeCodexSettings({ launchArgs: "--enable feature" })).toMatchObject({
      modelRoute: "default",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
      launchArgs: "--enable feature",
    });
    expect(decodeCodexSettings({ opencodexBaseUrl: "  " }).opencodexBaseUrl).toBe("");
  });

  it.each(["default", "opencodex"])(
    "round-trips both Codex route fields through an instance mutation (%s)",
    (modelRoute) => {
      const config = decodeCodexSettings({
        setupMode: "existing",
        modelRoute,
        opencodexBaseUrl: "http://127.0.0.1:10101/v1",
        launchArgs: "--enable feature",
      });
      const mutation = decodeInstanceMutation({
        operation: "upsert",
        instanceId: "codex_home",
        instance: { driver: "codex", displayName: "Codex · OpenCodex Home", config },
      });
      const restored = decodeInstanceMutation(
        JSON.parse(JSON.stringify(encodeInstanceMutation(mutation))),
      );
      expect(restored).toEqual(mutation);
      if (restored.operation === "remove") throw new Error("Expected an upsert mutation.");
      expect(decodeCodexSettings(restored.instance.config)).toEqual(config);
    },
  );

  it("rejects an unknown Codex model route", () => {
    expect(() => decodeCodexSettings({ modelRoute: "direct" })).toThrow();
  });

  it("round-trips provider_instance_busy errors", () => {
    const error = new ServerSettingsError({
      settingsPath: "/sandbox/settings.json",
      operation: "write-file",
      providerInstanceId: "codex_home",
      code: "provider_instance_busy",
    });
    const restored = decodeSettingsError(JSON.parse(JSON.stringify(encodeSettingsError(error))));
    expect(restored.code).toBe("provider_instance_busy");
    expect(restored.providerInstanceId).toBe("codex_home");
    expect(restored.message).toBe(
      "End this instance's active sessions before changing its model route.",
    );
  });

  it("preserves legacy settings errors without a code", () => {
    const restored = decodeSettingsError({
      _tag: "ServerSettingsError",
      settingsPath: "/sandbox/settings.json",
      operation: "write-file",
    });
    expect(restored.code).toBeUndefined();
    expect(restored.message).toBe("Server settings write-file failed at /sandbox/settings.json.");
  });
});

describe("automatic server updates", () => {
  it("defaults existing settings to enabled", () => {
    expect(decodeServerSettings({}).automaticServerUpdates).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.automaticServerUpdates).toBe(true);
  });

  it.each([true, false])("round-trips %s in environment patches", (automaticServerUpdates) => {
    const input = { automaticServerUpdates };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
    expect(requiredScopesForServerSettingsPatch(input)).toContain("settings:write");
  });

  // The scheduler reads one environment value; a project override would show but do nothing.
  it("cannot be overridden per project", () => {
    expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).not.toContain("automaticServerUpdates");
    const decoded = decodeServerSettings({
      projectSettingsOverrides: { project: { automaticServerUpdates: false } },
    });
    expect(decoded.projectSettingsOverrides[ProjectId.make("project")]).not.toHaveProperty(
      "automaticServerUpdates",
    );
  });

  it.each(["false", null, 0])("rejects a non-boolean value %s", (automaticServerUpdates) => {
    expect(() => decodeServerSettings({ automaticServerUpdates })).toThrow();
    expect(() => decodeServerSettingsPatch({ automaticServerUpdates })).toThrow();
  });
});

describe("channel automatic placement settings", () => {
  it("requires an explicit opt-in and uses normal settings write permission", () => {
    expect(decodeServerSettings({}).channelAutoPlacement).toBe(false);
    const patch = decodeServerSettingsPatch({ channelAutoPlacement: true });
    expect(patch.channelAutoPlacement).toBe(true);
    expect(requiredScopesForServerSettingsPatch(patch)).toContain("settings:write");
    expect(
      decodeServerSettings(encodeServerSettings(decodeServerSettings(patch))).channelAutoPlacement,
    ).toBe(true);
    expect(decodeServerSettingsPatch({ channelAutoPlacement: false }).channelAutoPlacement).toBe(
      false,
    );
  });
});

describe("host checkpoint replication settings", () => {
  it("keeps omission distinct from on and off and preserves host placement fields", () => {
    expect(decodeServerSettings({}).fleet.hosts).toBeUndefined();
    const fleet = {
      hosts: { box: { maxThreads: 4, allowGoals: false, checkpointReplication: "off" } },
    };
    expect(
      decodeServerSettings(encodeServerSettings(decodeServerSettings({ fleet }))).fleet,
    ).toEqual(fleet);
    expect(decodeServerSettingsPatch({ fleet })).toEqual({ fleet });
    expect(() =>
      decodeServerSettings({ fleet: { hosts: { box: { checkpointReplication: "automatic" } } } }),
    ).toThrow();
  });
});
