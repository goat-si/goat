import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AntigravitySettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSetupError,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@goat/contracts";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAntigravityProvider } from "./AntigravityProvider.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

export const modelOptions = [
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { value: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { value: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { value: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { value: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { value: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
];

export const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gemini-3.7-flash-high",
  options: modelOptions,
} satisfies EffectAcpSchema.SessionConfigOption;

export const sessionSetupResult = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-3.7-flash-high",
    availableModels: modelOptions.map((option) => ({ modelId: option.value, name: option.name })),
  },
  configOptions: [
    modelConfig,
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "yolo", name: "YOLO" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const instanceId = ProviderInstanceId.make("antigravity-test");
const driver = ProviderDriverKind.make("antigravity");

export const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    sessionCapabilities: { list: {}, resume: {} },
  },
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  agentInfo: {
    name: "antigravity-acp",
    title: "Google Antigravity",
    version: "agy_acp_server_20260818_01_RC01",
  },
} satisfies EffectAcpSchema.InitializeResponse;

export const started = {
  sessionId: "session-1",
  initializeResult,
  sessionSetupResult,
  modelConfigId: "model",
} satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult;

export const commands = [
  { name: "plan", description: "Create a plan", input: { type: "text", hint: "What to plan" } },
  { name: "logout", description: "Sign out of Google" },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

export const expectedCommands = [
  { name: "plan", description: "Create a plan", input: { hint: "What to plan" } },
  { name: "logout", description: "Sign out of Google" },
];

export const makeLayerTest = (background: boolean) =>
  ProviderHostLive.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("memory-host-fixture")),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(background),
      }),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-antigravity-provider-test-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

export const layerTest = makeLayerTest(false);

type ProbeError = EffectAcpErrors.AcpError | ProviderSetupError;

export const makeHarness = Effect.fn("makeAntigravityProviderHarness")(function* (
  options: {
    readonly auth?: { readonly type: string; readonly label: string };
    readonly enabled?: boolean;
    readonly safe?: boolean;
    readonly probeUsage?: Effect.Effect<ServerProviderUsageLimits>;
    readonly clearUsage?: Effect.Effect<void>;
    readonly currentProfile?: Effect.Effect<string>;
    readonly environment?: Effect.Effect<NodeJS.ProcessEnv>;
    readonly rememberedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  } = {},
) {
  const savedRuntimeModes = yield* Ref.make<ReadonlyArray<ReadonlyArray<RuntimeMode>>>([]);
  const initialProbe = yield* Deferred.make<EffectAcpSchema.InitializeResponse, ProbeError>();
  const probeCalls = yield* Ref.make(0);
  const safetyCalls = yield* Ref.make(0);
  const probe = yield* Ref.make<Effect.Effect<EffectAcpSchema.InitializeResponse, ProbeError>>(
    Deferred.await(initialProbe),
  );
  const safety = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(options.safe ?? true));
  const provider = yield* makeAntigravityProvider(
    decodeSettings({ enabled: options.enabled ?? true, customModels: ["do-not-seed-me"] }),
    {
      stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.probeUsage ? { probeUsage: options.probeUsage } : {}),
      ...(options.clearUsage ? { clearUsage: options.clearUsage } : {}),
      ...(options.currentProfile ? { currentProfile: options.currentProfile } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.rememberedRuntimeModes
        ? { rememberedRuntimeModes: options.rememberedRuntimeModes }
        : {}),
      rememberRuntimeModes: (modes) => Ref.update(savedRuntimeModes, (saved) => [...saved, modes]),
      probe: Ref.update(probeCalls, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(probe)),
        Effect.flatten,
      ),
      supportsTextGeneration: Ref.update(safetyCalls, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(safety)),
        Effect.flatten,
      ),
    },
  );
  const initialUpdate = yield* Stream.toPull(
    provider.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.installed || snapshot.status === "error"),
    ),
  );
  const initialize = Deferred.succeed(initialProbe, initializeResult).pipe(
    Effect.andThen(initialUpdate),
    Effect.asVoid,
  );
  // Subscribe before the trigger; yield the returned pull to await the publish.
  const nextPublish = (predicate: (snapshot: ServerProvider) => boolean) =>
    Stream.toPull(provider.snapshot.streamChanges.pipe(Stream.filter(predicate))).pipe(
      Effect.map((pull) => pull.pipe(Effect.map((snapshots) => snapshots[0]))),
    );
  return {
    provider,
    probe,
    probeCalls,
    safety,
    safetyCalls,
    initialProbe,
    initialUpdate,
    initialize,
    nextPublish,
    savedRuntimeModes,
  };
});
