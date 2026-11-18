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

it("memory requires an eligible model and guides require an eligible driver", () => {
  const unfit = [piProvider({ supportsTextGeneration: false })];
  const capable = [piProvider({})];
  expect(resolveMemoryModelSelection(settings, unfit, 0)).toEqual(
    createModelSelection(pi, "default"),
  );
  expect(resolveMemoryModelSelection(settings, capable, 0)).toEqual(extensionModel);
  expect(resolveReviewGuideModelSelection(settings, capable, null, 0)).toBeNull();
});

it("summary and conflict routes each require their own memory operation", () => {
  const summaryOnly = {
    ...piProvider({}),
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
  expect(resolveMemoryModelSelection(settings, providers, 0)).toEqual(extensionModel);
  expect(resolveMemoryModelSelection(settings, providers, 0, "conflict")).toEqual(codex);
  expect(resolveMemoryModelSelection(settings, [summaryOnly], 0, "conflict")).toBeNull();
});
