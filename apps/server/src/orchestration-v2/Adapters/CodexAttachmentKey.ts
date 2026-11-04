import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

// Only successful native attachments enter this cache, including effective authority.
// The computer use part comes first so a changed driver can be told from other changes.
export const attachmentKey = (
  config: McpProviderSession.McpProviderSessionConfig,
  cuaDriver: CuaDriverMcpConfiguration | undefined,
) => {
  const { read, write, source } = McpProviderSession.memoryToolAvailability(config);
  return JSON.stringify([
    `${McpProviderSession.cuaDriverKey(cuaDriver)}:${config.cuaDriverBlocked === true}`,
    `${config.providerSessionId}:${read}:${write}:${source}`,
  ]);
};

export const cuaPartOf = (key: string | undefined) =>
  key === undefined ? undefined : (JSON.parse(key) as ReadonlyArray<string>)[0];
