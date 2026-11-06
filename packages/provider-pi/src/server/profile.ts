import * as Path from "effect/Path";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";

export interface PiRuntimeProfile {
  readonly driver: "pi" | "omo";
  readonly displayName: string;
  readonly defaultBinary: string;
  readonly npmPackage: string;
  readonly nativeUpdateArgs: ReadonlyArray<string> | undefined;
  readonly pagedEntries: boolean;
  readonly spawnToolNames: ReadonlyArray<string>;
  readonly blockedNativeTools: ReadonlyArray<string>;
  /** Variables GOAT sets on every launch of this runtime. */
  readonly launchEnvironment: Readonly<Record<string, string>>;
}

export const PI_PROFILE: PiRuntimeProfile = Object.freeze({
  driver: "pi",
  displayName: "Pi",
  defaultBinary: "pi",
  npmPackage: "@earendil-works/pi-coding-agent",
  nativeUpdateArgs: Object.freeze(["update", "--self"]),
  pagedEntries: false,
  spawnToolNames: Object.freeze(["subagent"]),
  blockedNativeTools: Object.freeze([]),
  launchEnvironment: Object.freeze({}),
});

export const OMO_PROFILE: PiRuntimeProfile = Object.freeze({
  driver: "omo",
  displayName: "OmO",
  defaultBinary: "omo",
  npmPackage: "omo-ai",
  nativeUpdateArgs: undefined,
  pagedEntries: true,
  spawnToolNames: Object.freeze(["subagent", "task", "team_create", "workpool", "workflow"]),
  blockedNativeTools: Object.freeze(["computer", "computer_actions"]),
  // senpi's RPC client starts a detached host that otherwise stays up 15 minutes after GOAT
  // closes the session (senpi dist/modes/rpc/host-lifecycle-policy.js, host-idle-policy.js).
  launchEnvironment: Object.freeze({
    SENPI_RPC_HOST_IDLE_EXIT_MS: "1",
    SENPI_RPC_HOST_EMPTY_EXIT_MS: "1",
  }),
});

export function resolveOmoSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
  settingsSessionDir?: string,
): string {
  // senpi dist/main.js:1086-1089 uses the branded session env, then settings.
  const sessionDir = environment.OMO_CODING_AGENT_SESSION_DIR || settingsSessionDir;
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  return path.resolve(resolveOmoAgentDir(environment, home, path), "sessions");
}

export function resolveOmoAgentDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const agentDir = [
    environment.OMO_CODING_AGENT_DIR,
    environment.SENPI_CODING_AGENT_DIR,
    environment.PI_CODING_AGENT_DIR,
  ].find((value) => value?.trim());
  return path.resolve(
    agentDir ? expandHomePath(agentDir.trim(), home) : path.join(home, ".omo", "agent"),
  );
}
