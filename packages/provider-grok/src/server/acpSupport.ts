import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderApprovalOption,
  ProviderDriverKind,
  type RuntimeMode,
  TextGenerationError,
} from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";
import type { GrokSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@goat/shared/HostProcess";
import { normalizeModelSlug } from "@goat/shared/model";

import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { GROK_API_KEY_ENV } from "./auth.ts";
import { makeXAiPromptCompletionRuntime } from "./xaiAcpExtension.ts";

const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const GOAT_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

/** A fresh home excludes user/project hooks, plugins and MCP; policy tiers cannot be overridden. */
export const requireGrokMemoryIsolation = Effect.fn("requireGrokMemoryIsolation")(function* (
  operation: MemoryOperationName,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unavailable = new TextGenerationError({
    operation,
    detail: "Grok memory generation cannot isolate managed configuration or copy authentication.",
    cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
  });
  return yield* Effect.gen(function* () {
    for (const file of [
      "/etc/grok/managed_config.toml",
      "/etc/grok/requirements.toml",
      "/etc/grok/config.toml",
      "/Library/Application Support/ClaudeCode/managed-settings.json",
      "/etc/claude-code/managed-settings.json",
    ]) {
      if (yield* fs.exists(file)) {
        // Policy tiers may add mandatory hooks before any ACP callback exists.
        const info = yield* fs.stat(file);
        if (
          info.type !== "File" ||
          info.size > 64_000n ||
          (yield* fs.readFileString(file)).trim().length > 0
        )
          return yield* unavailable;
      }
    }
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-memory-" });
    const home = path.join(root, "profile");
    const cwd = path.join(root, "workspace");
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(cwd);
    const sourceHome =
      environment.GROK_HOME ?? path.join(environment.HOME ?? process.env.HOME ?? "", ".grok");
    const auth = path.join(sourceHome, "auth.json");
    if (yield* fs.exists(auth)) {
      yield* fs.copyFile(auth, path.join(home, "auth.json"));
      yield* fs.chmod(path.join(home, "auth.json"), 0o600);
    }
    yield* fs.writeFileString(
      path.join(home, "config.toml"),
      '[permissions]\ndefaultMode = "default"\n',
    );
    return {
      cwd,
      environment: {
        ...environment,
        HOME: root,
        GROK_HOME: home,
        CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      },
    };
  }).pipe(Effect.mapError(() => unavailable));
});

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

// grok agent treats settings-only acceptEdits as ask; it has no Auto-accept edits launch mode.
export const GROK_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

// argv overrides Grok config so Supervised cannot inherit always-approve.
export function grokAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case undefined:
      return ["agent", "stdio"];
    case "auto":
      return ["--permission-mode", "auto", "agent", "stdio"];
    case "full-access":
      return ["agent", "--always-approve", "stdio"];
    default:
      return ["--permission-mode", "default", "agent", "stdio"];
  }
}

function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: [...grokAcpSpawnArgs(runtimeMode)],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: GOAT_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

function grokAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  return {
    // macOS lacks a stable libproc identity provider for Grok's nested detached tool groups.
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

// Grok Ctrl+C blocks stale background wakes until the next genuine user turn.
export const GROK_ACP_CANCEL_META = { cancelTrigger: "ctrl_c" } as const;

/**
 * Grok's Auto mode asks the client about an action its classifier blocks only
 * when the client declares a type that can show a prompt; the default
 * (`generic`) gets a silent denial instead. `extension` is the prompting type
 * that keeps the permission options GOAT already maps (no always-approve row,
 * no per-command persistent grants).
 */
export const GROK_ACP_INITIALIZE_META = { clientType: "extension" } as const;

// Only allow-edits-session is session-scoped; other allow-always choices persist project grants.
const GROK_ALLOW_EDITS_SESSION_OPTION_ID = "allow-edits-session";

export function grokApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"], optionId?: string) =>
    request.options.some(
      (option) =>
        option.kind === kind && (optionId === undefined || option.optionId.trim() === optionId),
    );
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Decline" } as const] : []),
    ...(has("allow_always", GROK_ALLOW_EDITS_SESSION_OPTION_ID)
      ? [{ decision: "acceptForSession", label: "Allow all edits this session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Approve" } as const] : []),
  ];
}

export const makeGrokAcpRuntime = Effect.fn("GrokAcpSupport.makeGrokAcpRuntime")(function* (
  input: GrokAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const processGroupPlatform = yield* HostProcess.Platform.pipe(Effect.provide(NodeServices.layer));
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildGrokAcpSpawnInput(
        input.grokSettings,
        input.cwd,
        { ...input.environment, ...input.processEnvironment },
        input.runtimeMode,
      ),
      authMethodId: resolveGrokAuthMethodId(input.environment),
      cancelMeta: { ...input.cancelMeta, ...GROK_ACP_CANCEL_META },
      initializeMeta: GROK_ACP_INITIALIZE_META,
      ...grokAcpRuntimeProcessOwnership(processGroupPlatform),
    }),
  );
  const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
  return yield* makeXAiPromptCompletionRuntime(runtime);
});

// This product name is not an ACP model ID; it selects the current session model.
export const GROK_DEFAULT_MODEL_SLUG = "grok-build";

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : GROK_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? GROK_DEFAULT_MODEL_SLUG;
}

const GROK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidGrokReasoningEffortToken(value: string): boolean {
  return GROK_REASONING_EFFORT_TOKEN.test(value);
}

function normalizeGrokReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidGrokReasoningEffortToken(effort) ? effort : undefined;
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentGrokReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizeGrokReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId =
    input.requestedModelId === GROK_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  const modelChanged = requestedModelId !== undefined && requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeGrokReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  const targetModelId = requestedModelId ?? input.currentModelId;
  if ((!modelChanged && !reasoningEffortChanged) || targetModelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  const reasoningMeta =
    reasoningProvided && reasoningEffort !== undefined ? { reasoningEffort } : undefined;
  return input.runtime
    .setSessionModel(targetModelId, reasoningMeta)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}
