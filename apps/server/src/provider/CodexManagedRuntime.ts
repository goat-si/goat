import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { legacyEnvName } from "@goat/contracts/legacyT3Names";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const managedCodexLaunchArgs = [
  'model_provider="openai_token_sharing"',
  'model_providers.openai_token_sharing.name="OpenAI Token Sharing"',
  'model_providers.openai_token_sharing.base_url="https://api.openai.com/v1"',
  'model_providers.openai_token_sharing.model_catalog_url="https://api.openai.com/v1/models"',
  "features.api_key_model_discovery=true",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  'model_providers.openai_token_sharing.env_key="ACCESS_TOKEN"',
  'model_providers.openai_token_sharing.wire_api="responses"',
  "model_providers.openai_token_sharing.requires_openai_auth=false",
  "model_providers.openai_token_sharing.supports_websockets=false",
]
  .map((value) => `-c '${value}'`)
  .join(" ");

export const makeCodexManagedRuntime = Effect.fn("makeCodexManagedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings;
}) {
  if (options.config.modelRoute === "opencodex")
    return yield* new ProviderSetupError({
      instanceId: options.instanceId,
      operation: "runtime",
      detail: "OpenCodex routing needs a Codex instance that uses your Codex CLI.",
    });
  const installation = yield* CodexInstallation.CodexInstallation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const auth = yield* makeCodexChatGptAuth({
    instanceId: options.instanceId,
    defaultReturnUrl: new URL(
      "/welcome",
      config.devUrl ?? `http://localhost:${config.port}`,
    ).toString(),
  });
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    config.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
  const resolve = Effect.gen(function* () {
    const executable = yield* installation.acquire().pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "install",
            detail: "Set up managed Codex before starting a session.",
          }),
      ),
    );
    const credentials = yield* auth.access;
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: cause.message,
          }),
      ),
    );
    yield* fs.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the managed Codex runtime.",
          }),
      ),
    );
    // Ambient CLI overrides cannot redirect a GOAT-owned token to a different provider.
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      ACCESS_TOKEN: credentials.accessToken,
      CODEX_HOME: homePath,
    };
    for (const name of ["GOAT_CODEX_LAUNCH_ARGS", legacyEnvName("GOAT_CODEX_LAUNCH_ARGS")]) {
      if (name !== undefined) delete environment[name];
    }
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    return {
      config: decodeSettings({
        enabled: options.enabled,
        setupMode: "managed",
        modelRoute: "default",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: managedCodexLaunchArgs,
      }),
      environment,
      revision: credentials.accessToken,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});
