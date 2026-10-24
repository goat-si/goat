// @effect-diagnostics nodeBuiltinImport:off -- checks a real directory the helper made.
import * as NodeFS from "node:fs";
import { ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  memoryToolAvailability,
  withAgentDeviceEnvironment,
  withThreadMcpEnvironment,
} from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("memory tool availability", () => {
  it("fails closed for missing, cleared and unrelated grants", () => {
    for (const config of [
      undefined,
      {},
      { grantedScopes: [] },
      { grantedScopes: ["memory:write" as const] },
    ]) {
      expect(memoryToolAvailability(config)).toEqual({ read: false, write: false, source: false });
    }
  });
  it("requires independent source and write grants", () => {
    expect(memoryToolAvailability({ grantedScopes: ["memory:read"] })).toEqual({
      read: true,
      write: false,
      source: false,
    });
    expect(memoryToolAvailability({ grantedScopes: ["memory:read", "memory:write"] })).toEqual({
      read: true,
      write: true,
      source: false,
    });
    expect(
      memoryToolAvailability({ grantedScopes: ["memory:read", "orchestration:read"] }),
    ).toEqual({ read: true, write: false, source: true });
  });
});

describe("thread CLI environment", () => {
  it("replaces inherited thread credentials and fails closed when the session is absent (#934)", () => {
    const inherited = {
      GOAT_ACP_MCP_ENDPOINT: "http://parent/mcp",
      GOAT_ACP_MCP_AUTHORIZATION: "Bearer parent",
      T3_ACP_MCP_AUTHORIZATION: "Bearer legacy-parent", // goat-rename: legacy
      PROVIDER_KEY: "fixture-provider",
    };
    const current = withThreadMcpEnvironment(inherited, {
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer current-thread",
    });
    expect(current).toMatchObject({
      GOAT_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp",
      GOAT_ACP_MCP_AUTHORIZATION: "Bearer current-thread",
      T3_ACP_MCP_AUTHORIZATION: "Bearer current-thread", // goat-rename: legacy
      PROVIDER_KEY: "fixture-provider",
    });
    expect(withThreadMcpEnvironment(inherited, undefined)).toMatchObject({
      GOAT_ACP_MCP_ENDPOINT: "",
      GOAT_ACP_MCP_AUTHORIZATION: "",
      T3_ACP_MCP_AUTHORIZATION: "", // goat-rename: legacy
      PROVIDER_KEY: "fixture-provider",
    });
    expect(inherited.GOAT_ACP_MCP_AUTHORIZATION).toBe("Bearer parent");
  });

  it("gives each thread its own existing temporary directory (#1206)", () => {
    const session = { endpoint: "http://127.0.0.1:43123/mcp", authorizationHeader: "Bearer x" };
    const first = withThreadMcpEnvironment(
      {},
      { ...session, threadId: ThreadId.make("thread-tmp-first") },
    );
    const again = withThreadMcpEnvironment(
      {},
      { ...session, threadId: ThreadId.make("thread-tmp-first") },
    );
    const second = withThreadMcpEnvironment(
      {},
      { ...session, threadId: ThreadId.make("thread-tmp-second") },
    );

    expect(first.TMPDIR).toBe(again.TMPDIR);
    expect(first.TMPDIR).not.toBe(second.TMPDIR);
    for (const directory of [first.TMPDIR!, second.TMPDIR!]) {
      expect(NodeFS.statSync(directory).isDirectory()).toBe(true);
    }
    // A process shared by several threads keeps its own.
    expect(withThreadMcpEnvironment({ TMPDIR: "/inherited" }, undefined).TMPDIR).toBe("/inherited");
  });
});
