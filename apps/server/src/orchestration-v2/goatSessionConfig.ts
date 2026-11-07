import { resolveGoatMcpServersForDriver, type ThreadId } from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PermissionProfiles from "../goatclaw/PermissionProfiles.ts";
import type * as ServerSettings from "../serverSettings.ts";
import * as Credential from "./goatBotSessionCredential.ts";

/** Applies the thread's goatclaw native subagent limit to a provider session config. */
export const nativeSubagentLimiter =
  (permissionProfiles: Option.Option<PermissionProfiles.PermissionProfiles["Service"]>) =>
  (threadId: ThreadId, config: McpProviderSessionConfig) =>
    Effect.gen(function* () {
      const { nativeSubagentLimit: _previous, ...rest } = config;
      if (Credential.sessionNativeSubagentLimit(threadId) === 0)
        return { ...rest, nativeSubagentLimit: 0 };
      if (Option.isNone(permissionProfiles)) return rest;
      const limit = yield* permissionProfiles.value.nativeSubagentLimit(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read the goatclaw subagent limit; allowing none.", {
            cause,
          }).pipe(Effect.as(0)),
        ),
      );
      return limit === undefined ? rest : { ...rest, nativeSubagentLimit: limit };
    });

/**
 * GOAT-global MCP servers for a provider session. A renewed credential keeps the list the
 * provider process started with; a new one reads the current settings.
 */
export const goatMcpServersFor = Effect.fn("ProviderSessionManagerV2.goatMcpServersFor")(function* (
  existing: Pick<McpProviderSessionConfig, "goatMcpServers"> | undefined,
  renew: object | undefined,
  settings: Option.Option<Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">>,
  driver: string | undefined,
) {
  if (renew !== undefined && existing?.goatMcpServers !== undefined) return existing.goatMcpServers;
  if (Option.isNone(settings) || driver === undefined) return [];
  // An unreadable settings file must not stop the provider session; it starts without them.
  const current = yield* settings.value.getSettings.pipe(
    Effect.map((value) => value.mcpServers),
    Effect.catchCause((cause) =>
      Effect.logWarning("GOAT MCP servers skipped: settings unreadable", { cause }).pipe(
        Effect.as({}),
      ),
    ),
  );
  return resolveGoatMcpServersForDriver(current, driver);
});
