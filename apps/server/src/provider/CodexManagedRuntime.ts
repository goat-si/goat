import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveSelfInvocation, selfInvocationArgs } from "@goat/shared/nodeRuntime";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { legacyEnvName } from "@goat/contracts/legacyT3Names";
import { COMMAND_TIMEOUT_MS } from "./CodexManagedTokenProtocol.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";
import { usesAuthlessCodexHome } from "./CodexHomeRouteConfig.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const encodeRevision = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const managedCodexLaunchArgs = (command: string, args: ReadonlyArray<string>) =>
  [
    'model_provider="openai_token_sharing"',
    // Codex persists this provider ID in rollouts and needs it unchanged to resume.
    `model_providers.openai_token_sharing={name="OpenAI Token Sharing",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(command)},args=${JSON.stringify(args)},timeout_ms=${COMMAND_TIMEOUT_MS},refresh_interval_ms=0}}`,
    "features.api_key_model_discovery=true",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
const MANAGED_NEEDS_NONE =
  "Managed Codex uses Home with None authentication. OpenAI authentication for Home is available on an instance that uses your Codex CLI.";

/**
 * Managed Codex through Home with None: GOAT's managed executable and instance home, with no
 * token broker, secret store or ChatGPT sign-in. `acquire` holds the installation lease in the
 * caller's scope; `installed` only resolves the active release for status checks.
 */
export const resolveAuthlessManagedRuntime = Effect.fn("CodexManagedRuntime.resolveAuthless")(
  function* (input: {
    readonly settings: CodexSettings;
    readonly instanceId: ProviderInstanceId;
    readonly environment: NodeJS.ProcessEnv;
    readonly acquisition?: "acquire" | "installed";
  }) {
    const setupError = (operation: "install" | "runtime", detail: string) =>
      new ProviderSetupError({ instanceId: input.instanceId, operation, detail });
    if (input.settings.setupMode !== "managed" || !usesAuthlessCodexHome(input.settings))
      return yield* setupError(
        "runtime",
        "The authless managed runtime needs managed Codex with Home and None authentication.",
      );
    const installation = yield* CodexInstallation.CodexInstallation;
    const server = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const homeLayout = yield* resolveManagedCodexHomeLayout(
      server.stateDir,
      input.instanceId,
      input.settings,
    );
    const home = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
    const executable = yield* (
      input.acquisition === "installed"
        ? installation.resolve({ managedOnly: true })
        : installation.acquire({ managedOnly: true })
    ).pipe(
      Effect.mapError(() =>
        setupError("install", "Set up managed Codex before starting a session."),
      ),
    );
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError((cause) => setupError("runtime", cause.message)),
    );
    yield* fs
      .makeDirectory(home, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          setupError("runtime", "Could not prepare the managed Codex runtime."),
        ),
      );
    // Launchers extend the server environment, so empty values are needed to shadow ambient ones.
    const environment: NodeJS.ProcessEnv = {
      ...input.environment,
      CODEX_HOME: home,
      OPENAI_API_KEY: "",
      ACCESS_TOKEN: "",
      OPENAI_BASE_URL: "",
      GOAT_CODEX_LAUNCH_ARGS: "",
    };
    const legacyLaunchArgs = legacyEnvName("GOAT_CODEX_LAUNCH_ARGS");
    if (legacyLaunchArgs !== undefined) environment[legacyLaunchArgs] = "";
    return {
      binaryPath: executable.executablePath,
      home,
      homeLayout,
      config: decodeSettings({
        ...input.settings,
        binaryPath: executable.executablePath,
        homePath: home,
        launchArgs: "",
      }),
      environment,
      revision: encodeRevision([
        input.settings.opencodexAuth,
        input.settings.opencodexBaseUrl,
        executable.executablePath,
        executable.version,
        home,
      ]),
    } satisfies CodexEffectiveRuntime & {
      readonly binaryPath: string;
      readonly home: string;
      readonly homeLayout: typeof homeLayout;
    };
  },
);

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
      detail: MANAGED_NEEDS_NONE,
    });
  const installation = yield* CodexInstallation.CodexInstallation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environmentIdentity.getEnvironmentId;
  const invocation = yield* resolveSelfInvocation();
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
    // Establish renewal availability before auth.access can consume a refresh token.
    const endpoint = yield* broker.endpoint.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail:
              "Could not prepare the private managed Codex token listener. Restart GOAT and retry.",
            cause,
          }),
      ),
    );
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
    const profileKey = yield* auth.profileKey(credentials);
    const authArgs = selfInvocationArgs(invocation, [
      "__managed-chatgpt-token",
      endpoint,
      options.instanceId,
      environmentId,
      profileKey,
    ]);
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
      CODEX_HOME: homePath,
    };
    delete environment.ACCESS_TOKEN;
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
        launchArgs: managedCodexLaunchArgs(invocation.command, authArgs),
      }),
      environment,
      revision: profileKey,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});
