/**
 * Resolves the sibling Claude instance whose binary and claude.ai login a
 * Claude Cloud instance uses. Shared by the driver and provider diagnosis so
 * both refuse the same configurations for the same reasons.
 */
import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import {
  ClaudeCloudError,
  prepareClaudeCloudEnvironment,
  type ClaudeCloudLogin,
} from "@goat/provider-claude-cloud/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { isWindowsClaudeLauncherShimPath, resolveClaudeSdkExecutable } from "./ClaudeExecutable.ts";

const decodeSiblingSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const isCloudError = Schema.is(ClaudeCloudError);

/** Routing that would send a cloud login through bundles, API keys, Git overrides, or third parties. */
const CLAUDE_CLOUD_FORBIDDEN_ENVIRONMENT = [
  "CCR_FORCE_BUNDLE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

/** Names of the forbidden variables set in `environment`. An empty value counts as unset. */
export const forbiddenClaudeCloudVariables = (input: NodeJS.ProcessEnv): string[] => {
  const environment = prepareClaudeCloudEnvironment(input);
  return Object.keys(environment)
    .filter((key) =>
      key.startsWith("GIT_")
        ? Boolean(environment[key])
        : (CLAUDE_CLOUD_FORBIDDEN_ENVIRONMENT as ReadonlyArray<string>).includes(key) &&
          Boolean(environment[key]?.trim()),
    )
    .toSorted();
};

const fail = (detail: string, fields: Partial<ConstructorParameters<typeof ClaudeCloudError>[0]>) =>
  Effect.fail(new ClaudeCloudError({ detail, outcome: "rejected", ...fields }));

const searchedPath = (environment: NodeJS.ProcessEnv): string => {
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH");
  const entries = (key === undefined ? "" : (environment[key] ?? ""))
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? "PATH is empty" : `GOAT looked in PATH: ${entries.join("; ")}`;
};

const mapResolutionError = Effect.mapError((cause: unknown) =>
  isCloudError(cause)
    ? cause
    : new ClaudeCloudError({
        detail: "Could not resolve the sibling Claude configuration.",
        outcome: "rejected",
        cause,
      }),
);

/**
 * The sibling's login without the refusals that depend on its result (`forbidden`,
 * `nativeBinary` false for a shim or script, `binaryFound` false for a Windows miss).
 * Diagnosis uses it to report every blocker at once; launches use {@link resolveClaudeCloudLogin}.
 */
export const resolveClaudeCloudSibling = Effect.fn("resolveClaudeCloudSibling")(function* (
  sourceInstanceId: ProviderInstanceId,
) {
  const host = yield* ProviderHost.ProviderHost;
  const processEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const settings = yield* host.settings.get;
  const entry = settings.providerInstances[sourceInstanceId];
  if (!entry && sourceInstanceId !== ProviderInstanceId.make("claudeAgent"))
    return yield* fail("The selected sibling Claude instance no longer exists.", {
      reason: "sibling_missing",
    });
  if (entry && entry.driver !== ProviderDriverKind.make("claudeAgent"))
    return yield* fail("Claude Cloud must use a Claude sibling instance.", {
      reason: "sibling_invalid",
    });
  const sibling = yield* decodeSiblingSettings(entry?.config ?? {});
  const merged = yield* mergeClaudeProcessEnvironment(
    sibling,
    entry?.environment,
    processEnvironment,
  );
  const environment = prepareClaudeCloudEnvironment(yield* makeClaudeEnvironment(sibling, merged));
  const executable = yield* resolveClaudeSdkExecutable(
    expandHomePath(sibling.binaryPath, homeDirectory),
    environment,
  );
  const binary = executable.path;
  const home = yield* resolveClaudeHomePath(sibling, environment);
  return {
    login: {
      binary,
      environment,
      binding: `claudeCloud:${sourceInstanceId}:${home}:${binary}`,
    } satisfies ClaudeCloudLogin,
    forbidden: forbiddenClaudeCloudVariables(environment),
    nativeBinary: !isWindowsClaudeLauncherShimPath(binary) && !/\.(?:js|mjs|cjs)$/i.test(binary),
    binaryFound: executable.found,
  };
}, mapResolutionError);

/** The sibling's native binary, merged environment, and the binding that names this login. */
export const resolveClaudeCloudLogin = Effect.fn("resolveClaudeCloudLogin")(function* (
  sourceInstanceId: ProviderInstanceId,
) {
  const { login, forbidden, nativeBinary, binaryFound } =
    yield* resolveClaudeCloudSibling(sourceInstanceId);
  // ConPTY would get the bare name and fail with a generic PTY error.
  if (!binaryFound)
    return yield* fail(
      `Claude CLI not found: ${login.binary} did not resolve to a native Claude executable on this machine. ${searchedPath(login.environment)}. Install Claude Code, or set the binary path of Claude instance ${sourceInstanceId}.`,
      { reason: "executable_unsupported" },
    );
  if (forbidden.length > 0)
    return yield* fail(
      "The sibling has bundle, Git routing or third-party/API-key routing variables. Use a Claude instance configured for claude.ai cloud login.",
      { reason: "forbidden_environment", variables: forbidden },
    );
  if (!nativeBinary)
    return yield* fail(
      "Claude Cloud requires the native Claude executable for PTY launch. Update or select the sibling's native binary.",
      { reason: "executable_unsupported" },
    );
  return login;
});
