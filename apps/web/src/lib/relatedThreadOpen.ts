import type { EnvironmentId } from "@goat/contracts";

interface ShellFamiliesConfig {
  readonly shellThreadFamilies?: boolean | undefined;
}

/**
 * Whether the target environment's shell leaves idle subagent children out, read from that
 * environment's own configuration: the timeline's environment and the thread's can differ.
 */
export function targetShellOmitsChildren(input: {
  readonly targetEnvironmentId: EnvironmentId;
  readonly currentEnvironmentId: EnvironmentId;
  readonly currentConfig: ShellFamiliesConfig | null | undefined;
  readonly configs: ReadonlyMap<EnvironmentId, ShellFamiliesConfig>;
}): boolean {
  const config =
    input.targetEnvironmentId === input.currentEnvironmentId
      ? input.currentConfig
      : input.configs.get(input.targetEnvironmentId);
  return config?.shellThreadFamilies === true;
}
