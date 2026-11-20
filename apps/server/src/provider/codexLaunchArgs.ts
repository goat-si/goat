import { tokenizeCliArgs } from "@goat/shared/cliArgs";

const GOAT_CODEX_LAUNCH_ARGS_ENV = "GOAT_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const override = environment[GOAT_CODEX_LAUNCH_ARGS_ENV];
  return override?.trim() ? override : launchArgs?.trim() || "";
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (
  launchArgs?: string,
  routeArgs: ReadonlyArray<string> = [],
  unloadImmediately = false,
) => [
  "app-server",
  ...(unloadImmediately ? ["-c", "thread_unload_delay_secs=0"] : []),
  ...codexLaunchArgv(launchArgs),
  ...routeArgs,
];

const SHARED_VALUE_FLAGS = new Set(["--config", "-c", "--enable", "--disable", "--profile", "-p"]);
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable=", "--profile=", "-p="];

const filterLaunchArgs = (args: ReadonlyArray<string>, exec: boolean) => {
  const kept: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const rawArg = args[index];
    if (rawArg === undefined) continue;
    const arg = rawArg.replace(/^(-[cp])(?=[^=])/u, "$1=");
    if (exec && (arg === "--strict-config" || arg === "--oss")) kept.push(arg);
    else if (SHARED_VALUE_FLAGS.has(arg) || (exec && arg === "--local-provider")) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (
      SHARED_INLINE_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
      (exec && arg.startsWith("--local-provider="))
    )
      kept.push(arg);
  }
  return kept;
};

const mcpDisabledFeatures = new Set(["apps", "connectors", "plugins"]);
const execDisabledFeatures = new Set([...mcpDisabledFeatures, "hooks", "codex_hooks"]);
const omitFeatureEnables = (args: ReadonlyArray<string>, features: ReadonlySet<string>) =>
  args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !features.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !features.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && features.has(arg));
  });

export const codexExecLaunchArgs = (launchArgs?: string, routeArgs: ReadonlyArray<string> = []) => [
  ...omitFeatureEnables(filterLaunchArgs(codexLaunchArgv(launchArgs), true), execDisabledFeatures),
  ...routeArgs,
];

export const codexMcpListLaunchArgs = (args: ReadonlyArray<string>) =>
  omitFeatureEnables(filterLaunchArgs(args, false), mcpDisabledFeatures);
