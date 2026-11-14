import { tokenizeCliArgs } from "@goat/shared/cliArgs";

const GOAT_CODEX_LAUNCH_ARGS_ENV = "GOAT_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[GOAT_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

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
    const arg = args[index];
    if (arg === undefined) continue;
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

export const codexExecLaunchArgs = (launchArgs?: string, routeArgs: ReadonlyArray<string> = []) => [
  ...filterLaunchArgs(codexLaunchArgv(launchArgs), true),
  ...routeArgs,
];

export const codexMcpListLaunchArgs = (args: ReadonlyArray<string>) =>
  filterLaunchArgs(args, false);
