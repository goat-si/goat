import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import {
  GOAT_CUA_MCP_ENV,
  GOAT_MCP_BEARER_ENV,
  GOAT_MCP_URL_ENV,
  GOAT_PI_RUNTIME_MODE_ENV,
  GOAT_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import { legacyEnvName } from "@goat/contracts/legacyT3Names";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("hands the session's Cua Driver to GOAT's extension only, never from the parent", () => {
    const cuaDriver = {
      command: "/resources/cua-driver",
      args: ["mcp"],
      environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
    };
    const inherited = { [GOAT_CUA_MCP_ENV]: '{"command":"/stale/cua-driver","args":[]}' };
    const launch = (input: { readonly attached: boolean; readonly extension: boolean }) =>
      buildPiRpcLaunch({
        launchArgs: [],
        environment: inherited,
        mcpSession: input.attached ? { ...mcpSession, cuaDriver } : mcpSession,
        extensionPath: input.extension ? "/tmp/cache/pi-goat-mcp-extension.ts" : undefined,
      }).env[GOAT_CUA_MCP_ENV];
    assert.deepEqual(JSON.parse(launch({ attached: true, extension: true }) ?? "null"), {
      command: "/resources/cua-driver",
      args: ["mcp"],
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
    });
    assert.isUndefined(launch({ attached: false, extension: true }));
    assert.isUndefined(launch({ attached: true, extension: false }));
  });

  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-goat-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-goat-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env.GOAT_ACP_MCP_ENDPOINT, mcpSession.endpoint);
    assert.equal(launch.env.GOAT_ACP_MCP_AUTHORIZATION, mcpSession.authorizationHeader);
    assert.equal(launch.env[GOAT_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[GOAT_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[GOAT_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(launch.env[GOAT_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-goat-mcp-extension.ts");
    // An extension materialized by an older build reads the legacy names.
    assert.equal(launch.env[legacyEnvName(GOAT_MCP_URL_ENV)!], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[legacyEnvName(GOAT_MCP_BEARER_ENV)!], "secret-pi-token");
    // Older extensions identify their own tools by this exact spelling.
    assert.equal(launch.env.T3_PI_MCP_EXTENSION_PATH, "/tmp/cache/pi-goat-mcp-extension.ts"); // goat-rename: legacy
    assert.equal(launch.env.T3_PI_RUNTIME_MODE, "approval-required"); // goat-rename: legacy

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [GOAT_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [legacyEnvName(GOAT_MCP_BEARER_ENV)!]: "stale-token",
        [GOAT_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-goat-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-goat-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasGoatMcp);
    assert.isUndefined(permissionOnly.env[GOAT_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[GOAT_MCP_BEARER_ENV]);
    assert.isUndefined(permissionOnly.env[legacyEnvName(GOAT_MCP_BEARER_ENV)!]);
    assert.equal(permissionOnly.env[GOAT_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[GOAT_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-goat-mcp-extension.ts",
    );
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-goat-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasGoatMcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by GOAT and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });
});
