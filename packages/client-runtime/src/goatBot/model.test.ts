import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveGoatBotModelSettings } from "./model.ts";

function makeProvider(input: {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled?: boolean;
  status?: ServerProvider["status"];
  availability?: ServerProvider["availability"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

function makeModel(
  slug: string,
  name = slug,
  options?: { isDefault?: boolean; isCustom?: boolean; isLegacy?: boolean },
): ServerProvider["models"][number] {
  return {
    slug,
    name,
    isCustom: options?.isCustom ?? false,
    ...(options?.isDefault ? { isDefault: true } : {}),
    ...(options?.isLegacy ? { isLegacy: true } : {}),
    capabilities: null,
  };
}

describe("deriveGoatBotModelSettings", () => {
  it("resolves Automatic against the new-thread default and marks unavailable providers", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      goatBotModelSelection: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    };
    const codex = makeProvider({
      instanceId: "codex",
      driver: "codex",
      models: [makeModel("gpt-5.4", "GPT-5.4", { isDefault: true })],
    });

    const missing = deriveGoatBotModelSettings({ settings, providers: [codex] });
    expect(missing.separate).toBe(false);
    expect(missing.automaticLabel).toBe("Automatic · claude-sonnet-4-6 (not available)");
    expect(missing.summaryLabel).toBe("Automatic · claude-sonnet-4-6 (not available)");
    expect(missing.initialSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });

    const claude = makeProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: [makeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", { isDefault: true })],
    });
    const connected = deriveGoatBotModelSettings({ settings, providers: [codex, claude] });
    expect(connected.automaticLabel).toBe("Automatic · claude-sonnet-4-6");
    expect(connected.initialSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it("builds choices from ready enabled instances, applying custom models, hidden models, and model order", () => {
    const codexId = ProviderInstanceId.make("codex");
    const customClaudeId = ProviderInstanceId.make("claude_work");
    const defaultClaudeId = ProviderInstanceId.make("claudeAgent");
    const antigravityId = ProviderInstanceId.make("antigravity");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      goatBotModelSelection: {
        instanceId: codexId,
        model: "custom-fast",
      },
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: {
            customModels: [{ slug: "custom-fast", name: "Custom Fast" }],
          },
        },
        [customClaudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          displayName: "Claude Work",
        },
        [defaultClaudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
        },
        [antigravityId]: {
          driver: ProviderDriverKind.make("antigravity"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [codexId]: {
          hiddenModels: ["gpt-hidden"],
          modelOrder: ["custom-fast", "gpt-5.4"],
        },
      },
    };
    const providers = [
      makeProvider({
        instanceId: "claude_work",
        driver: "claudeAgent",
        displayName: "Claude Work",
        models: [makeModel("claude-opus-4-6", "Claude Opus 4.6")],
      }),
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        models: [makeModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      }),
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        models: [
          makeModel("gpt-5.4", "GPT-5.4", { isDefault: true }),
          makeModel("gpt-hidden", "GPT Hidden"),
          makeModel("stale-custom", "Stale Custom", { isCustom: true }),
        ],
      }),
      makeProvider({
        instanceId: String(antigravityId),
        driver: "antigravity",
        models: [
          makeModel(ANTIGRAVITY_DEFAULT_MODEL, "Default"),
          makeModel("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ],
      }),
      makeProvider({
        instanceId: "cursor",
        driver: "cursor",
        status: "error",
        models: [makeModel("composer-2", "Composer 2")],
      }),
    ];

    const result = deriveGoatBotModelSettings({ settings, providers });
    expect(result.separate).toBe(true);
    expect(result.summaryLabel).toBe("Codex · Custom Fast");
    expect(result.choices.map((choice) => choice.key)).toEqual([
      "claudeAgent:claude-sonnet-4-6",
      "claude_work:claude-opus-4-6",
      "codex:custom-fast",
      "codex:gpt-5.4",
      "antigravity:gemini-2.5-pro",
    ]);
  });
});
