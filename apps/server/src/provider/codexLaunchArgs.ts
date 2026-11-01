import { tokenizeCliArgs } from "@goat/shared/cliArgs";

const GOAT_CODEX_LAUNCH_ARGS_ENV = "GOAT_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[GOAT_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string, routeArgs: ReadonlyArray<string> = []) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
  ...routeArgs,
];

export const codexExecLaunchArgs = (launchArgs?: string, routeArgs: ReadonlyArray<string> = []) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (
      arg === "--config" ||
      arg === "-c" ||
      arg === "--enable" ||
      arg === "--disable" ||
      arg === "--profile" ||
      arg === "-p"
    ) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (
      arg.startsWith("--enable=") ||
      arg.startsWith("--disable=") ||
      arg.startsWith("--profile=")
    ) {
      execArgs.push(arg);
    }
  }

  return [...execArgs, ...routeArgs];
};
