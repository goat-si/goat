import { tokenizeCliArgs } from "@goat/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  withThreadMcpEnvironment,
  type McpProviderSessionConfig,
} from "@goat/provider-core/server/mcpSession";
import { legacyEnvName, withLegacyEnvNames } from "@goat/contracts/legacyT3Names";
import {
  PI_GOAT_MCP_EXTENSION_FILENAME,
  PI_GOAT_MCP_EXTENSION_SOURCE,
  GOAT_CUA_MCP_ENV,
  GOAT_CUA_GATE_ENV,
  GOAT_MCP_BEARER_ENV,
  GOAT_MCP_URL_ENV,
  GOAT_PI_RUNTIME_MODE_ENV,
  GOAT_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi parses equals-form tokens only as extension flags, even when their name
  // matches a built-in option. Split known built-ins while leaving arbitrary
  // extension flags in their native form.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by GOAT and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Pi extensions may register arbitrary long flags. Treat one following
      // non-flag token as that extension flag's value.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by GOAT.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function piGoatMcpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_GOAT_MCP_EXTENSION_FILENAME}`;
}

export const materializePiGoatMcpExtension = Effect.fn("materializePiGoatMcpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = piGoatMcpExtensionDestPath(cacheDir);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== PI_GOAT_MCP_EXTENSION_SOURCE) {
    yield* fs.writeFileString(dest, PI_GOAT_MCP_EXTENSION_SOURCE);
  }
  return dest;
});

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  /** The per-turn computer use gate; only a process launched with the driver gets it. */
  readonly cuaGatePath?: string | undefined;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasGoatMcp: boolean;
} {
  const hasGoatExtension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasGoatMcp = hasGoatExtension && input.mcpSession !== undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...launchArgs,
    // Restrictions follow user launch args so a configured --tools or
    // --extension cannot silently re-enable unattended text-generation code.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  if (
    hasGoatExtension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const environment = withThreadMcpEnvironment(
    input.environment,
    hasGoatMcp ? input.mcpSession : undefined,
  );
  // These values belong to the current GOAT session. Never let a Pi child reuse
  // credentials inherited from the server or a parent provider process.
  for (const name of [GOAT_MCP_URL_ENV, GOAT_MCP_BEARER_ENV, GOAT_PI_MCP_EXTENSION_PATH_ENV]) {
    delete environment[name];
    delete environment[legacyEnvName(name) ?? name];
  }
  delete environment[GOAT_CUA_MCP_ENV];
  delete environment[GOAT_CUA_GATE_ENV];
  // The driver reaches Pi only through GOAT's extension bridge, fixed at launch.
  const cuaDriver = hasGoatMcp ? input.mcpSession?.cuaDriver : undefined;

  return {
    args,
    env: {
      ...environment,
      // An extension materialized by an older build reads the legacy names.
      ...withLegacyEnvNames({
        ...(hasGoatExtension && input.extensionPath !== undefined
          ? { [GOAT_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }
          : {}),
        ...(hasGoatExtension && input.runtimeMode !== undefined
          ? {
              [GOAT_PI_RUNTIME_MODE_ENV]:
                input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
            }
          : {}),
        ...(hasGoatMcp && input.mcpSession !== undefined
          ? {
              [GOAT_MCP_URL_ENV]: input.mcpSession.endpoint,
              [GOAT_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
                input.mcpSession.authorizationHeader,
              ),
            }
          : {}),
      }),
      ...(cuaDriver === undefined
        ? {}
        : {
            [GOAT_CUA_MCP_ENV]: JSON.stringify({
              command: cuaDriver.command,
              args: cuaDriver.args,
              env: Object.fromEntries(
                cuaDriver.environment.map(({ name, value }) => [name, value]),
              ),
            }),
            ...(input.cuaGatePath === undefined ? {} : { [GOAT_CUA_GATE_ENV]: input.cuaGatePath }),
          }),
    },
    hasGoatMcp,
  };
}
