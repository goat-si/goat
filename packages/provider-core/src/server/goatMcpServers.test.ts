import { describe, expect, it } from "vite-plus/test";
import { goatAcpServers, goatCodexServers, goatSdkServers } from "./goatMcpServers.ts";

const servers = [
  {
    providerName: "local_goat",
    transport: "stdio",
    command: "tool",
    args: ["run"],
    env: { KEY: "value" },
  },
  {
    providerName: "remote_goat",
    transport: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "fixture" },
  },
] as const;

describe("GOAT MCP provider mappings", () => {
  it("maps stdio and HTTP to SDK shapes", () => {
    expect(goatSdkServers(servers)).toEqual({
      local_goat: { type: "stdio", command: "tool", args: ["run"], env: { KEY: "value" } },
      remote_goat: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "fixture" },
      },
    });
  });
  it("maps Codex entries only when the effective config is known and does not conflict", () => {
    expect(goatCodexServers(servers, undefined)).toEqual({});
    expect(goatCodexServers(servers, { local_goat: {} })).toEqual({
      "mcp_servers.remote_goat": {
        url: "https://example.test/mcp",
        http_headers: { Authorization: "fixture" },
      },
    });
    expect(goatCodexServers(servers, {})).toEqual({
      "mcp_servers.local_goat": { command: "tool", args: ["run"], env: { KEY: "value" } },
      "mcp_servers.remote_goat": {
        url: "https://example.test/mcp",
        http_headers: { Authorization: "fixture" },
      },
    });
  });
  it("maps only stdio for ACP", () => {
    expect(goatAcpServers(servers)).toEqual([
      {
        name: "local_goat",
        command: "tool",
        args: ["run"],
        env: [{ name: "KEY", value: "value" }],
      },
    ]);
  });
});
