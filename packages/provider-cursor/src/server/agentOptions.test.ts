import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import {
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  makeCursorAgentOptions,
} from "./agentOptions.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

describe("Cursor agent options", () => {
  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          approvalPolicy: "never",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    // Auto-review can gate Windows execution without the unsupported SDK sandbox.
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          sandboxPolicy: { type: "workspaceWrite" },
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(cursorMcpServers(mcpSession), {
      goat: {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: {
          Authorization: "Bearer secret-cursor-mcp-token",
        },
      },
    });

    const options = makeCursorAgentOptions({
      apiKey: "secret-cursor-api-key",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2.5",
      },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
      threadId,
      mcpSession,
      platform: "linux",
    });
    assert.deepEqual(options.mcpServers, cursorMcpServers(mcpSession));

    const logged = JSON.stringify(CursorAgentSdk.loggedCursorAgentOptions(options));
    assert.notInclude(logged, "secret-cursor-api-key");
    assert.notInclude(logged, "secret-cursor-mcp-token");
  });
});
