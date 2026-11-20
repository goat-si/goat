import { expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
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
const checkedAt = "2026-11-17T00:00:00.000Z";
const now = Date.parse(checkedAt);
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
    checkedAt,
    models: [
      { slug: "demo/demo-model", name: "Demo", isCustom: false, capabilities: null, ...model },
    ],
    slashCommands: [],
    skills: [],
  }) satisfies ServerProvider;

it("memory fallback from a standalone generator picks OmO's default instead of gpt-6-luna", () => {
  const omo = ProviderInstanceId.make("omo");
  const standalone = ProviderInstanceId.make("standalone");
  const driver = ProviderDriverKind.make("omo");
  const selection = createModelSelection(standalone, "standalone-model");
  const onlyOmo = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [omo]: { driver, enabled: true, config: {} } },
    textGenerators: {
      [standalone]: {
        kind: "openaiCompatible",
        baseUrl: "https://model.example/v1",
        apiKey: "",
        enabled: true,
      },
    },
    textGenerationModelSelection: selection,
  } satisfies ServerSettings;
  const providers = [
    { ...piProvider({ slug: "default", name: "OmO default" }), instanceId: omo, driver },
  ];
  expect(resolveMemoryModelSelection(onlyOmo, providers, now)).toEqual({
    instanceId: omo,
    model: "default",
  });
  expect(resolveReviewGuideModelSelection(onlyOmo, providers, null, now)).toEqual(selection);
});

it.each([
  ["writer", resolveSourceControlWriterModelSelection],
  [
    "review guide",
    (input: typeof settings, providers: ReadonlyArray<ServerProvider>) =>
      resolveReviewGuideModelSelection(input, providers, null, now),
  ],
  [
    "memory",
    (input: typeof settings, providers: ReadonlyArray<ServerProvider>) =>
      resolveMemoryModelSelection(input, providers, now),
  ],
] as const)(
  "the %s selection skips a model its provider cannot use for text generation, and keeps it when an older server omits the flag",
  (_label, resolve) => {
    expect(resolve(settings, [piProvider({ supportsTextGeneration: false })], null)).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(resolve(settings, [piProvider({})], null)).toEqual(extensionModel);
  },
);

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
