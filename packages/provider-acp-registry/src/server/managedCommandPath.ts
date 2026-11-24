import { mergePathEntries } from "@goat/shared/shell";

function readEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  return (
    environment.PATH ??
    Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
  );
}

export function withPreferredPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: mergePathEntries(directory, readEnvironmentPath(environment, platform), platform),
  };
}

export function withoutNpmPrefix(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== "npm_config_prefix"),
  );
}
