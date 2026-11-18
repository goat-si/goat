import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  fallbackTextGenerationModelSelection,
  resolveMemoryModelSelection,
  resolveReviewGuideModelSelection,
} from "./serverSettings.ts";

const API = ProviderInstanceId.make("api-fixture");
const CHECKED_AT = "2026-11-17T00:00:00.000Z";
const NOW = Date.parse(CHECKED_AT);
// Memory and review guides need a coding agent, so an API text generator always falls back.
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  textGenerators: {
    [API]: {
      kind: "openaiCompatible",
      baseUrl: "https://model.example/v1",
      apiKey: "",
      enabled: true,
    },
  },
  memoryModelSelection: createModelSelection(API, "fixture-model"),
  sourceControlWriterModelSelection: createModelSelection(API, "fixture-model"),
};

const ready = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: CHECKED_AT,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const spent: ServerProvider["usageLimits"] = {
  checkedAt: CHECKED_AT,
  windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100, exhausted: true }],
};

describe("text generation fallback candidates", () => {
  it("skips signed-out, uninstalled, errored and usage-exhausted providers", () => {
    const providers = [
      ready("codex", { auth: { status: "unauthenticated" } }),
      ready("claudeAgent", { installed: false }),
      ready("cursor", { status: "error" }),
      ready("grok", { usageLimits: spent }),
      ready("muse"),
      ready("omo"),
    ];
    const configured: ServerSettings = {
      ...settings,
      providerInstances: Object.fromEntries(
        ["cursor", "grok", "muse", "omo"].map((driver) => [
          ProviderInstanceId.make(driver),
          { driver: ProviderDriverKind.make(driver), enabled: true },
        ]),
      ),
    };

    expect(resolveMemoryModelSelection(configured, providers, NOW)?.instanceId).toBe(
      ProviderInstanceId.make("omo"),
    );
  });

  it("keeps a provider whose usage reading is stale and not exhausted", () => {
    const stale: ServerProvider["usageLimits"] = {
      checkedAt: "2026-01-01T00:00:00.000Z",
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40 }],
    };

    expect(
      resolveMemoryModelSelection(settings, [ready("codex", { usageLimits: stale })], NOW)
        ?.instanceId,
    ).toBe(ProviderInstanceId.make("codex"));
  });

  it("moves a review guide past a signed-out Codex to Claude", () => {
    const providers = [
      ready("codex", { auth: { status: "unauthenticated" } }),
      ready("claudeAgent"),
    ];

    expect(resolveReviewGuideModelSelection(settings, providers, null, NOW)?.instanceId).toBe(
      ProviderInstanceId.make("claudeAgent"),
    );
  });

  it("skips a provider the project turned off", () => {
    const project = ProjectId.make("project-off");
    const withOverride: ServerSettings = {
      ...settings,
      projectSettingsOverrides: {
        [project]: {
          providerInstances: { [ProviderInstanceId.make("codex")]: { enabled: false } },
        },
      },
    };
    const providers = [ready("codex"), ready("claudeAgent")];

    expect(
      resolveReviewGuideModelSelection(withOverride, providers, project, NOW)?.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(resolveReviewGuideModelSelection(withOverride, providers, null, NOW)?.instanceId).toBe(
      ProviderInstanceId.make("codex"),
    );
  });
});

describe("OmO's text generation default", () => {
  it("runs memory on OmO's default model", () => {
    const omo = ProviderInstanceId.make("omo");
    const withOmo: ServerSettings = {
      ...settings,
      providerInstances: { [omo]: { driver: ProviderDriverKind.make("omo"), enabled: true } },
    };
    expect(resolveMemoryModelSelection(withOmo, [ready("omo")], NOW)).toEqual(
      createModelSelection(ProviderInstanceId.make("omo"), "default"),
    );
  });

  it("settings normalization picks OmO's default model", () => {
    const omo = ProviderInstanceId.make("omo");
    expect(fallbackTextGenerationModelSelection({}, (instanceId) => instanceId === omo)).toEqual(
      createModelSelection(omo, "default"),
    );
  });
});
