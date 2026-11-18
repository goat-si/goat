// @effect-diagnostics nodeBuiltinImport:off -- the key is computed synchronously for each update.
import * as NodeCrypto from "node:crypto";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpRegistrySettings } from "../settings.ts";

const isClaudeAcpAgent = (settings: AcpRegistrySettings) =>
  (settings.source !== "local" && settings.agentId === "claude-acp") ||
  (settings.source === "local" &&
    /^claude-agent-acp(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? ""));

/** The environment a session of these settings launches with. */
export const acpRegistrySessionEnvironment = (
  settings: AcpRegistrySettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
  isClaudeAcpAgent(settings)
    ? {
        ...environment,
        CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: environment.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2 ?? "1",
      }
    : environment;

/** Names one session environment, for comparing where configuration came from; holds no values. */
export const acpRegistryEnvironmentKey = (environment: NodeJS.ProcessEnv): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .digest("hex");

// The environment each session's reported config options came from, by the array it reported.
const configurationOrigins = new WeakMap<
  ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  string
>();

export const withConfigurationOrigin = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  environmentKey: string,
) => {
  const tagged = [...configOptions];
  configurationOrigins.set(tagged, environmentKey);
  return tagged;
};

export const configurationOrigin = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) => configurationOrigins.get(configOptions);
