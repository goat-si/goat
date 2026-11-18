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
  expect(resolveMemoryModelSelection(onlyOmo, providers)).toEqual({
    instanceId: omo,
    model: "default",
  });
  expect(resolveReviewGuideModelSelection(onlyOmo, providers, null)).toEqual(selection);
});

it.each([
  ["writer", resolveSourceControlWriterModelSelection],
  ["review guide", resolveReviewGuideModelSelection],
  [
    "memory",
    (input: typeof settings, providers: ReadonlyArray<ServerProvider>) =>
      resolveMemoryModelSelection(input, providers),
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
