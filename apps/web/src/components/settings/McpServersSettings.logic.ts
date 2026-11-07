import {
  GOAT_MCP_SERVER_SUPPORT,
  GoatMcpServer,
  McpServerName,
  type GoatMcpServer as Server,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const isServerName = Schema.is(McpServerName);
const isServer = Schema.is(GoatMcpServer);

export type Draft = {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  entries: Array<{ id: string; key: string; value: string }>;
  enabled: boolean;
};

export function draftFor(name = "", server?: Server): Draft {
  return {
    name,
    transport: server?.transport ?? "stdio",
    enabled: server?.enabled ?? true,
    command: server?.transport === "stdio" ? server.command : "",
    args: server?.transport === "stdio" ? server.args.join("\n") : "",
    url: server?.transport === "http" ? server.url : "",
    entries: Object.entries(
      server?.transport === "stdio" ? server.env : (server?.headers ?? {}),
    ).map(([key, value]) => ({ id: key, key, value })),
  };
}

export function serverFromDraft(
  draft: Draft,
  existingNames: ReadonlySet<string>,
  originalName?: string,
): { name: string; server: Server } | { error: string } {
  if (!isServerName(draft.name))
    return {
      error:
        "Name must start with a lowercase letter or number and contain at most 40 lowercase letters, numbers, or hyphens.",
    };
  if (draft.name !== originalName && existingNames.has(draft.name))
    return { error: "A server with this name already exists." };
  const keys = draft.entries.map(({ key }) => key);
  if (new Set(keys).size !== keys.length) return { error: "Each key must be unique." };
  const values = Object.fromEntries(draft.entries.map(({ key, value }) => [key, value]));
  const server =
    draft.transport === "stdio"
      ? {
          enabled: draft.enabled,
          transport: "stdio" as const,
          command: draft.command,
          args: draft.args === "" ? [] : draft.args.split("\n"),
          env: values,
        }
      : { enabled: draft.enabled, transport: "http" as const, url: draft.url, headers: values };
  if (!isServer(server))
    return {
      error:
        "Check the command, URL and key names. URLs must use HTTPS or loopback HTTP, without credentials, query or fragment.",
    };
  return { name: draft.name, server };
}

export function supportedProviders(transport: Server["transport"]): string {
  const names = [
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["cursor", "Cursor"],
  ] as const;
  const labels: string[] = names
    .filter(([driver]) => GOAT_MCP_SERVER_SUPPORT[driver]?.includes(transport))
    .map(([, label]) => label);
  if (
    ["grok", "antigravity", "acpRegistry", "fx"].some((driver) =>
      GOAT_MCP_SERVER_SUPPORT[driver]?.includes(transport),
    )
  )
    labels.push("ACP agents");
  return labels.join(", ");
}
