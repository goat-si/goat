import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

it("replaces and removes MCP servers by name without disturbing other entries", () => {
  const local = {
    enabled: true,
    transport: "stdio" as const,
    command: "first",
    args: [],
    env: { OLD: "x" },
  };
  const other = {
    enabled: true,
    transport: "http" as const,
    url: "https://example.test",
    headers: {},
  };
  const current = { ...DEFAULT_SERVER_SETTINGS, mcpServers: { local, other } };
  const replacement = { ...local, command: "second", env: {} };
  expect(
    applyServerSettingsPatch(current, { mcpServers: { local: replacement } }).mcpServers,
  ).toEqual({ local: replacement, other });
  expect(applyServerSettingsPatch(current, { mcpServers: { local: null } }).mcpServers).toEqual({
    other,
  });
});
