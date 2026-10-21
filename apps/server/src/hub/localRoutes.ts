import {
  providerInstanceConfigEnabledFlag,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const OpenCodeConfig = Schema.Struct({
  model: Schema.optional(Schema.String),
  provider: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        options: Schema.optional(Schema.Struct({ baseURL: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});
const decodeOpenCode = Schema.decodeUnknownOption(Schema.fromJsonString(OpenCodeConfig));

const usesLocalPort = (value: string | undefined, port: number, pathname: "" | "/v1") => {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port || 80) === port &&
      url.pathname.replace(/\/+$/, "") === pathname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

export interface LocalOpenCodexRoute {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  /** ok: served through this device's OpenCodex; failed: bypasses it; unproven: not known. */
  readonly status: "ok" | "failed" | "unproven";
  readonly reason: string;
}

/**
 * Which enabled provider instances reach models through this device's OpenCodex on `port`.
 * Drivers OpenCodex does not wire (cloud agents, Cursor, Grok) are not listed: they never use it.
 */
export function localOpenCodexRoutes(input: {
  readonly instances: ServerSettings["providerInstances"];
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly environment: NodeJS.ProcessEnv;
  readonly port: number;
}): Array<LocalOpenCodexRoute> {
  const routes: Array<LocalOpenCodexRoute> = [];
  for (const [id, entry] of Object.entries(input.instances)) {
    const instanceId = id as ProviderInstanceId;
    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (
      entry.enabled === false ||
      provider?.enabled === false ||
      providerInstanceConfigEnabledFlag(entry.config) === false
    )
      continue;
    const add = (status: LocalOpenCodexRoute["status"], reason: string) =>
      routes.push({ instanceId, driver: entry.driver, status, reason });
    if (entry.driver === "codex") {
      // This URL comes from Codex's config/read, after verifyEffectiveCodexRoute for a
      // managed Home route. An inspect-only "connected" label is insufficient evidence.
      const effective =
        provider?.status === "ready" ? provider.codexRoute?.effectiveBaseUrl : undefined;
      add(
        effective === undefined
          ? "unproven"
          : usesLocalPort(effective, input.port, "/v1")
            ? "ok"
            : "failed",
        "Codex effective endpoint must use the device's OpenCodex port.",
      );
    } else if (entry.driver === "claudeAgent") {
      const value =
        entry.environment?.find(({ name }) => name === "ANTHROPIC_BASE_URL")?.value ??
        input.environment.ANTHROPIC_BASE_URL;
      add(
        usesLocalPort(value, input.port, "") ? "ok" : "failed",
        "Claude Code ANTHROPIC_BASE_URL must use local OpenCodex.",
      );
    } else if (entry.driver === "opencode") {
      // OpenCodex's OpenCode launcher puts its provider in this inline layer, which
      // outranks workspace/user config. A global file alone cannot prove the route.
      const inline =
        entry.environment?.find(({ name }) => name === "OPENCODE_CONFIG_CONTENT")?.value ??
        input.environment.OPENCODE_CONFIG_CONTENT;
      const config = inline === undefined ? undefined : decodeOpenCode(inline);
      const document = config?._tag === "Some" ? config.value : undefined;
      const providerId = document?.model?.split("/")[0];
      const endpoint = providerId ? document?.provider?.[providerId]?.options?.baseURL : undefined;
      add(
        endpoint === undefined
          ? "unproven"
          : usesLocalPort(endpoint, input.port, "/v1")
            ? "ok"
            : "failed",
        "OpenCode's selected provider in the inline runtime config must use local OpenCodex.",
      );
    }
  }
  return routes;
}
