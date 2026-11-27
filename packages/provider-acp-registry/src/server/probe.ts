import { isolateDeepSeekProbeHistory } from "./deepSeekProbeHistory.ts";
import { shellDisplayToken } from "./shellDisplayToken.ts";
import { boundedAgentVersion } from "./agentVersion.ts";
import {
  AcpRegistryOperationError,
  AcpRegistryProbeResult,
  type AcpRegistryProbeAuthMethod,
  type AcpRegistryProbeModel,
  type AcpRegistryUrlAuthAction,
  type ProviderInstanceId,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@goat/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
} from "@goat/provider-core/server/snapshotProbe";

import * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  findModelConfigOption,
  parseSessionModeState,
} from "@goat/provider-acp/server/runtimeModel";
import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
  isAcpThoughtLevelOption,
} from "@goat/provider-acp/server/sessionConfig";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  discoverAcpRegistryModelOptions,
  type AcpRegistryModelDiscovery,
} from "./modelDiscovery.ts";
import {
  acpRegistryProbeFailure,
  boundedOpaqueValue,
  boundedText,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  normalizeAcpRegistryWebUrl,
} from "./probeHelpers.ts";

export { type AcpRegistryModelDiscovery } from "./modelDiscovery.ts";
export { acpRegistryProbeFailure, normalizeAcpRegistryWebUrl } from "./probeHelpers.ts";
export {
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistryProviders,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  makeAcpRegistryManagementRuntime,
  setAcpRegistryProvider,
} from "./probeManagement.ts";

const MAX_AUTH_METHODS = 32;
const MAX_MODELS = 256;
const MAX_NAME_LENGTH = 160;
// Generous enough for real agents' command menus while bounding what one probe holds and sends.
const MAX_COMMANDS = 1_024;
const MAX_COMMAND_LINE_LENGTH = 2_048;
const PROBE_TIMEOUT_MS = 60_000;
const COMMAND_ADVERTISEMENT_GRACE = "500 millis";
// Agents that fetch their catalog after session setup (Qoder CLI, OpenCode)
// settle it in seconds, not milliseconds; commands arrive much sooner.
const MODEL_ADVERTISEMENT_GRACE = "5 seconds";
const PROBE_SESSION_DELETE_TIMEOUT = "5 seconds";

/**
 * The session's reasoning option with the levels a model advertises in `_meta`, in the
 * shape Grok uses. Null represents an explicit opt-out.
 */
function advertisedReasoningEffort(
  option: EffectAcpSchema.SessionConfigOption | undefined,
  meta: Readonly<Record<string, unknown>> | null | undefined,
): AcpRegistryProbeModel["reasoningEffort"] {
  if (meta == null) return undefined;
  if (meta.supportsReasoningEffort === false) return null;
  if (option?.type !== "select" || !Array.isArray(meta.reasoningEfforts)) return undefined;
  const options = meta.reasoningEfforts.flatMap((level: unknown) =>
    typeof level === "object" &&
    level !== null &&
    "value" in level &&
    typeof level.value === "string"
      ? [
          {
            value: level.value,
            name: "label" in level && typeof level.label === "string" ? level.label : level.value,
          },
        ]
      : [],
  );
  const currentValue = typeof meta.reasoningEffort === "string" ? meta.reasoningEffort : "";
  return acpProviderOptionDescriptors({
    configOptions: [{ ...option, options, currentValue }],
    modeState: undefined,
  })[0];
}

function normalizedModel(id: string, candidate: AcpRegistryProbeModel): AcpRegistryProbeModel {
  return {
    id,
    name: boundedText(candidate.name, MAX_NAME_LENGTH) || id,
    description:
      candidate.description === null
        ? null
        : boundedText(candidate.description, MAX_DESCRIPTION_LENGTH) || null,
  };
}

function normalizeModels(
  candidates: ReadonlyArray<AcpRegistryProbeModel>,
  currentModelId: string | null,
): ReadonlyArray<AcpRegistryProbeModel> {
  const seen = new Set<string>();
  const models: Array<AcpRegistryProbeModel> = [];
  for (const candidate of candidates) {
    if (models.length === MAX_MODELS) break;
    const id = boundedOpaqueValue(candidate.id, MAX_ID_LENGTH);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push(normalizedModel(id, candidate));
  }
  // Keep the running model visible even when its advertised position exceeds the cap.
  if (currentModelId !== null && models.length === MAX_MODELS && !seen.has(currentModelId)) {
    const current = candidates.find((candidate) => candidate.id === currentModelId);
    if (current !== undefined) {
      models[MAX_MODELS - 1] = normalizedModel(currentModelId, current);
    }
  }
  return models;
}

export interface AcpRegistryAuthSpawnContext {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function terminalAuthCommand(
  method: Extract<EffectAcpSchema.AuthMethod, { readonly type: "terminal" }>,
  spawn: AcpRegistryAuthSpawnContext,
): string | undefined {
  const environmentPrefix = Object.entries(method.env ?? {}).map(
    ([name, value]) => `${name}=${shellDisplayToken(value)}`,
  );
  const command = [spawn.command, ...spawn.args, ...(method.args ?? [])].map(shellDisplayToken);
  const displayCommand = [...environmentPrefix, ...command].join(" ");
  return displayCommand.length <= MAX_COMMAND_LINE_LENGTH ? displayCommand : undefined;
}

export function normalizeAcpRegistryAuthMethods(
  methods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
  spawn?: AcpRegistryAuthSpawnContext,
): ReadonlyArray<AcpRegistryProbeAuthMethod> {
  const normalized: Array<AcpRegistryProbeAuthMethod> = [];
  for (const method of methods ?? []) {
    const id = boundedOpaqueValue(method.id, MAX_ID_LENGTH);
    if (id === undefined) continue;
    const type = method.type ?? "agent";
    const envVarNames =
      type === "env_var" && "vars" in method
        ? method.vars
            .flatMap((variable) => {
              const name = boundedOpaqueValue(variable.name, MAX_ID_LENGTH);
              return name === undefined ? [] : [name];
            })
            .slice(0, 16)
        : [];
    const command =
      spawn !== undefined && "type" in method && method.type === "terminal"
        ? terminalAuthCommand(method, spawn)
        : undefined;
    const link =
      type === "env_var" && "link" in method && method.link
        ? normalizeAcpRegistryWebUrl(method.link)
        : undefined;
    normalized.push({
      id,
      name: boundedText(method.name, MAX_NAME_LENGTH) || id,
      description:
        method.description == null
          ? null
          : boundedText(method.description, MAX_DESCRIPTION_LENGTH) || null,
      type,
      ...(command === undefined ? {} : { command }),
      ...(envVarNames.length > 0 ? { envVarNames } : {}),
      ...(link === undefined ? {} : { link }),
    });
    if (normalized.length === MAX_AUTH_METHODS) break;
  }
  return normalized;
}

export interface AcpRegistryAvailableCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface AcpRegistryLiveConfiguration {
  readonly models: ReadonlyArray<AcpRegistryProbeModel>;
  readonly currentModelId: string | null;
  readonly configOptions: AcpRegistryProbeResult["configOptions"];
  readonly modelOptionIds?: NonNullable<AcpRegistryProbeResult["modelOptionIds"]>;
  /** The environment of the session that reported it, when a session did. */
  readonly environmentKey?: string;
  // A single model from an explicit select is the agent's deliberate catalog
  // (e.g. an entitlement change), not a cold-start placeholder.
  readonly modelsFromModelSelect?: boolean;
}

export function normalizeAcpRegistryLiveConfiguration(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState?: Parameters<typeof acpProviderOptionDescriptors>[0]["modeState"],
  modelState?: EffectAcpSchema.SessionModelState | null,
): AcpRegistryLiveConfiguration {
  const modelOption = findModelConfigOption(configOptions);
  const currentModelId =
    modelOption?.type === "select" ? modelOption.currentValue : modelState?.currentModelId;
  const candidates =
    modelOption === undefined
      ? (modelState?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description ?? null,
        }))
      : flattenSelectChoices(modelOption.options).map((model) => ({
          id: model.value,
          name: model.name,
          description: model.description ?? null,
        }));
  const boundedCurrentModelId =
    currentModelId === undefined
      ? null
      : (boundedOpaqueValue(currentModelId, MAX_ID_LENGTH) ?? null);
  const effortOption =
    configOptions.find((option) => option.category === "thought_level") ??
    configOptions.find(isAcpThoughtLevelOption);
  const models = normalizeModels(candidates, boundedCurrentModelId).map((model) => {
    const reasoningEffort = advertisedReasoningEffort(
      effortOption,
      modelState?.availableModels.find((info) => info.modelId === model.id)?._meta,
    );
    return reasoningEffort === undefined ? model : { ...model, reasoningEffort };
  });
  const descriptors = acpProviderOptionDescriptors({ configOptions, modeState });
  const modelOptionIds = new Set(
    configOptions
      .filter((option) => isAcpThoughtLevelOption(option) || option.category === "model_config")
      .map((option) => option.id),
  );
  return {
    models,
    currentModelId: models.some((model) => model.id === boundedCurrentModelId)
      ? boundedCurrentModelId
      : null,
    configOptions: descriptors,
    modelOptionIds: descriptors
      .filter((descriptor) => modelOptionIds.has(descriptor.id))
      .map((descriptor) => descriptor.id),
    modelsFromModelSelect: modelOption !== undefined,
  };
}

const emptyAcpRegistryAvailableCommands = (): AcpRegistryAvailableCommands => ({
  slashCommands: [],
  skills: [],
});

export function acpRegistryAdvertisesModelCatalog(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelState?: EffectAcpSchema.SessionModelState | null,
): boolean {
  const modelOption = findModelConfigOption(configOptions);
  return (
    (modelOption !== undefined && flattenSelectChoices(modelOption.options).length > 1) ||
    (modelState?.availableModels?.length ?? 0) > 1
  );
}

export function normalizeAcpRegistryCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): AcpRegistryAvailableCommands {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    if (seen.size >= MAX_COMMANDS) break;
    const name = boundedOpaqueValue(command.name, MAX_ID_LENGTH);
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = boundedText(command.description, MAX_DESCRIPTION_LENGTH);
    const hint = command.input ? boundedText(command.input.hint, MAX_DESCRIPTION_LENGTH) : "";
    if (name.startsWith("$")) {
      const skillName = boundedOpaqueValue(name.slice(1), MAX_ID_LENGTH);
      if (skillName === undefined) continue;
      skills.push({
        name: skillName,
        ...(description ? { description } : {}),
        path: `acp://skill/${encodeURIComponent(skillName)}`,
        scope: "agent",
        enabled: true,
      });
    } else {
      slashCommands.push({
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
  }
  return { slashCommands, skills };
}

export function acpRegistryProbeResult(
  instanceId: ProviderInstanceId,
  started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  icon: string | null = null,
  spawn?: AcpRegistryAuthSpawnContext,
  liveConfiguration?: AcpRegistryLiveConfiguration,
): AcpRegistryProbeResult {
  const configuration =
    liveConfiguration ??
    normalizeAcpRegistryLiveConfiguration(
      started.sessionSetupResult.configOptions ?? [],
      parseSessionModeState(started.sessionSetupResult),
      started.sessionSetupResult.models,
    );
  const agentVersion = boundedAgentVersion(started.initializeResult.agentInfo?.version);
  return AcpRegistryProbeResult.make({
    instanceId,
    ready: true,
    icon,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    authMethods: normalizeAcpRegistryAuthMethods(started.initializeResult.authMethods, spawn),
    sessionManagement: {
      canList: started.initializeResult.agentCapabilities?.sessionCapabilities?.list != null,
      canLoad: started.initializeResult.agentCapabilities?.loadSession === true,
      canResume: started.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null,
      canLogout: started.initializeResult.agentCapabilities?.auth?.logout != null,
      canDelete: started.initializeResult.agentCapabilities?.sessionCapabilities?.delete != null,
      canConfigureProviders: started.initializeResult.agentCapabilities?.providers != null,
    },
    ...configuration,
  });
}

export interface AcpRegistryConfigurationProbeInput {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelDiscovery?: AcpRegistryModelDiscovery;
}

export interface AcpRegistryConfigurationProbeResult {
  readonly probe: AcpRegistryProbeResult;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export type AcpRegistryConfigurationProbe<Requirements = never> = (
  input: AcpRegistryConfigurationProbeInput,
) => Effect.Effect<AcpRegistryConfigurationProbeResult, AcpRegistryOperationError, Requirements>;

export const probeAcpRegistryConfiguration = Effect.fn("AcpRegistryProbe.probeConfiguration")(
  function* (
    input: AcpRegistryConfigurationProbeInput,
  ): Effect.fn.Return<
    AcpRegistryConfigurationProbeResult,
    AcpRegistryOperationError,
    | AcpRegistrySupport.AcpRegistryCatalog
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | SecureRandom.SecureRandom
  > {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const probeTimeoutMs = resolveProviderProbeTimeoutMs(
      "acp_registry",
      PROBE_TIMEOUT_MS,
      input.environment,
    );
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const random = yield* SecureRandom.SecureRandom;
    const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);

    const openSession = Effect.gen(function* () {
      // A background probe only resolves agents already prepared on this host.
      const resolved = yield* catalog
        .resolve(input.settings, input.cwd, input.environment, { allowInstall: false })
        .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError));
      const prepared = yield* catalog
        .prepareRuntimeSpawn(resolved)
        .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError));
      const spawn = yield* isolateDeepSeekProbeHistory(input.settings.commandPath, prepared);
      const authMethodsRef = yield* Ref.make<ReadonlyArray<AcpRegistryProbeAuthMethod>>([]);
      const authActionRef = yield* Ref.make<AcpRegistryUrlAuthAction | undefined>(undefined);
      const runtimeCoordinator = yield* Effect.serviceOption(
        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
      );
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: {
            ...spawn,
            env: providerProbeEnvironment(spawn.env ?? input.environment),
          },
          cwd: input.cwd,
          clientCapabilities: {
            auth: { terminal: Option.isSome(pty) },
            elicitation: { url: {} },
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-provider-test", version: "0.0.0" },
          authenticateOnAuthRequired: false,
          onInitialized: (initializeResult) =>
            Ref.set(
              authMethodsRef,
              normalizeAcpRegistryAuthMethods(initializeResult.authMethods, {
                command: resolved.spawn.command,
                args: resolved.spawn.args,
              }),
            ),
          ...(input.settings.authMethodId ? { authMethodId: input.settings.authMethodId } : {}),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              Layer.succeed(SecureRandom.SecureRandom, random),
            ),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(runtimeContext),
      );
      const commandsRef = yield* Ref.make<AcpRegistryAvailableCommands>(
        emptyAcpRegistryAvailableCommands(),
      );
      const commandsAdvertised = yield* Deferred.make<void>();
      const configOptionsRef = yield* Ref.make<
        ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined
      >(undefined);
      const modelsAdvertised = yield* Deferred.make<void>();
      yield* runtime.handleElicitation((request) =>
        Effect.gen(function* () {
          if (
            request.mode !== "url" ||
            !("url" in request) ||
            !("elicitationId" in request) ||
            typeof request.url !== "string" ||
            typeof request.elicitationId !== "string"
          ) {
            return { action: "decline" } as const;
          }
          const url = normalizeAcpRegistryWebUrl(request.url);
          const elicitationId = boundedOpaqueValue(request.elicitationId, MAX_ID_LENGTH);
          if (url === undefined || elicitationId === undefined) {
            return { action: "decline" } as const;
          }
          const action: AcpRegistryUrlAuthAction = {
            elicitationId,
            url,
            message: boundedText(request.message, MAX_DESCRIPTION_LENGTH),
          };
          yield* Ref.set(authActionRef, action);
          const accepted = yield* Option.match(runtimeCoordinator, {
            onNone: () => Effect.succeed(false),
            onSome: (coordinator) => coordinator.requestUrlAuthentication(input.instanceId, action),
          });
          return accepted ? ({ action: "accept" } as const) : ({ action: "decline" } as const);
        }),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "available_commands_update") {
          return Ref.set(commandsRef, normalizeAcpRegistryCommands(update.availableCommands)).pipe(
            Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)),
            Effect.asVoid,
          );
        }
        if (update.sessionUpdate === "config_option_update") {
          const hasAdvertisedModels = acpRegistryAdvertisesModelCatalog(update.configOptions);
          return Ref.set(configOptionsRef, update.configOptions).pipe(
            Effect.andThen(
              hasAdvertisedModels
                ? Deferred.succeed(modelsAdvertised, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          );
        }
        return Effect.void;
      });
      const startResult = yield* Effect.result(runtime.start());
      if (Result.isFailure(startResult)) {
        return yield* acpRegistryProbeFailure(
          startResult.failure,
          yield* Ref.get(authMethodsRef),
          yield* Ref.get(authActionRef),
        );
      }
      const started = startResult.success;
      // Agents that persist sessions (OpenCode) would otherwise keep one empty session per probe.
      // The runtime only sends session/delete when the agent advertises it.
      yield* Effect.addFinalizer(() =>
        runtime
          .deleteSession(started.sessionId)
          .pipe(Effect.timeoutOption(PROBE_SESSION_DELETE_TIMEOUT), Effect.ignore),
      );
      const hasInitialModels = acpRegistryAdvertisesModelCatalog(
        started.sessionSetupResult.configOptions,
        started.sessionSetupResult.models,
      );

      yield* Effect.all(
        [
          hasInitialModels
            ? Effect.void
            : Deferred.await(modelsAdvertised).pipe(
                Effect.timeoutOption(MODEL_ADVERTISEMENT_GRACE),
              ),
          Deferred.await(commandsAdvertised).pipe(
            Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE),
          ),
        ],
        { concurrency: "unbounded" },
      );

      // config_option_update replaces the full option set, so an empty notice is authoritative.
      const liveConfiguration = normalizeAcpRegistryLiveConfiguration(
        (yield* Ref.get(configOptionsRef)) ?? (yield* runtime.getConfigOptions),
        (yield* runtime.getModeState) ?? parseSessionModeState(started.sessionSetupResult),
        started.sessionSetupResult.models,
      );

      return {
        resolved,
        started,
        commands: yield* Ref.get(commandsRef),
        liveConfiguration,
        runtime,
      };
    }).pipe(
      Effect.timeoutOrElse({
        duration: probeTimeoutMs,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: `The ACP agent did not resolve and create a test session within ${probeTimeoutMs / 1_000} seconds. Package installation or agent startup may be slow; this check retries on the next provider refresh.`,
            }),
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      const session = yield* openSession;
      const result: AcpRegistryConfigurationProbeResult = {
        probe: acpRegistryProbeResult(
          input.instanceId,
          session.started,
          session.resolved.agent?.icon ?? null,
          {
            command: session.resolved.spawn.command,
            args: session.resolved.spawn.args,
          },
          session.liveConfiguration,
        ),
        slashCommands: session.commands.slashCommands,
        skills: session.commands.skills,
      };
      // Runs in the probe session before it is deleted, outside the setup deadline.
      if (input.modelDiscovery !== undefined) {
        yield* discoverAcpRegistryModelOptions(
          session.runtime,
          session.liveConfiguration.currentModelId,
          result,
          input.modelDiscovery,
          normalizeAcpRegistryLiveConfiguration,
        );
      }
      return result;
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        error._tag === "AcpRegistryOperationError" ? error : acpRegistryProbeFailure(error),
      ),
    );
  },
);
