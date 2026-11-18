import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@goat/contracts";
import { compareSemverVersions } from "@goat/shared/semver";
import * as Effect from "effect/Effect";
import {
  customClaudeApiEndpointHost,
  readClaudeSettingsEnv,
} from "../../provider/Drivers/ClaudeSkills.ts";

const versionError =
  /^API Error: 400 Claude Code (\d+\.\d+\.\d+) does not support this model; version (\d+\.\d+\.\d+) or newer is required\./;

export const claudeVersionError = Effect.fn("ClaudeAdapter.versionError")(function* (
  message: SDKResultMessage,
  sessionVersion: string | undefined,
  settings: ClaudeSettings,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  if (
    message.subtype !== "success" ||
    message.terminal_reason !== "api_error" ||
    sessionVersion === undefined
  )
    return undefined;
  const [, reported, required] = versionError.exec(message.result.trim()) ?? [];
  if (
    reported === undefined ||
    required === undefined ||
    compareSemverVersions(reported, sessionVersion) >= 0 ||
    compareSemverVersions(sessionVersion, required) < 0
  )
    return undefined;
  const settingsEnv = yield* readClaudeSettingsEnv(settings, cwd, environment);
  const endpointHost = customClaudeApiEndpointHost(
    settingsEnv.ANTHROPIC_BASE_URL ?? environment.ANTHROPIC_BASE_URL,
  );
  return endpointHost === undefined
    ? undefined
    : `The custom API endpoint ${endpointHost} reported Claude Code ${reported}, but this session runs Claude Code ${sessionVersion}. Running claude update will not fix this; the endpoint or a proxy behind it rewrote the version.`;
});
