import { expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@goat/contracts";
import { createModelSelection } from "./model.ts";
import {
  fallbackTextGenerationModelSelection,
  resolveMemoryModelSelection,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

it("uses Big Pickle when only OpenCode is enabled", () => {
  expect(
    fallbackTextGenerationModelSelection({}, (instanceId) => instanceId === "opencode"),
  ).toEqual({ instanceId: "opencode", model: "opencode/big-pickle" });
});

const pi = ProviderInstanceId.make("pi");
const extensionModel = createModelSelection(pi, "demo/demo-model");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [pi]: { driver: ProviderDriverKind.make("pi"), enabled: true, config: {} } },
  sourceControlWriterModelSelection: extensionModel,
  reviewGuideModelSelection: extensionModel,
  memoryModelSelection: extensionModel,
};
const piProvider = (model: Partial<ServerProviderModel>) =>
  ({
    instanceId: pi,
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: "0.84.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T00:00:00.000Z",
    models: [
      { slug: "demo/demo-model", name: "Demo", isCustom: false, capabilities: null, ...model },
    ],
    slashCommands: [],
    skills: [],
  }) satisfies ServerProvider;

it("the writer skips a session-only model and accepts an older snapshot without a capability flag", () => {
  expect(
    resolveSourceControlWriterModelSelection(
      settings,
      [piProvider({ supportsTextGeneration: false })],
      null,
    ),
  ).toEqual(settings.textGenerationModelSelection);
  expect(resolveSourceControlWriterModelSelection(settings, [piProvider({})], null)).toEqual(
    extensionModel,
  );
});

it("legacy Pi snapshots are ineligible for memory and guides", () => {
  const capable = [piProvider({})];
  expect(resolveMemoryModelSelection(settings, capable, 0)).toBeNull();
  expect(resolveReviewGuideModelSelection(settings, capable, null, 0)).toBeNull();
});

it.each([{ modelRoute: "opencodex" }, { serverUrl: "https://opencode.example" }])(
  "legacy OpenCode snapshots use the configured route %j for both memory operations",
  (config) => {
    const openCode = createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5");
    const codex = settings.textGenerationModelSelection;
    const snapshots = [
      {
        ...piProvider({}),
        instanceId: openCode.instanceId,
        driver: ProviderDriverKind.make("opencode"),
        models: [],
      },
      {
        ...piProvider({}),
        instanceId: codex.instanceId,
        driver: ProviderDriverKind.make("codex"),
        models: [],
      },
    ];
    const configured = {
      ...settings,
      memoryModelSelection: openCode,
      providerInstances: {
        [openCode.instanceId]: {
          driver: ProviderDriverKind.make("opencode"),
          enabled: true,
          config,
        },
      },
    };
    for (const operation of ["summary", "conflict"] as const) {
      expect(resolveMemoryModelSelection(configured, snapshots, 0, operation)).toEqual(codex);
    }
  },
);

it("summary and conflict routes each require their own memory operation", () => {
  const claude = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-5-5");
  const summaryOnly = {
    ...piProvider({}),
    instanceId: claude.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [],
    memoryGeneration: { summary: true, conflict: false },
  };
  const codex = settings.textGenerationModelSelection;
  const conflictOnly = {
    ...piProvider({}),
    instanceId: codex.instanceId,
    driver: ProviderDriverKind.make("codex"),
    models: [],
    memoryGeneration: { summary: false, conflict: true },
  };
  const providers = [summaryOnly, conflictOnly];
  expect(resolveMemoryModelSelection(settings, providers, 0)).toEqual(claude);
  expect(resolveMemoryModelSelection(settings, providers, 0, "conflict")).toEqual(codex);
  expect(resolveMemoryModelSelection(settings, [summaryOnly], 0, "conflict")).toBeNull();
});
