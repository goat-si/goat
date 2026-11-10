import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "@goat/provider-core/server/developmentInstructions";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { CLAUDE_TEST_MODEL_SELECTION } from "./ClaudeTestInput.testkit.ts";

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
      browserToolsAvailable: true,
    };

    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    assert.deepEqual(overrides, {
      allowedTools: ["Read", "mcp__goat__*"],
      mcpServers: {
        goat: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-claude-token",
          },
          timeout: ClaudeAdapterV2.CLAUDE_GOAT_MCP_TOOL_TIMEOUT_MS,
        },
      },
      mcpEnvironment: { NO_PROXY: "127.0.0.1" },
    });

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-claude-mcp",
      resume: false,
      cwd: "/workspace",
      allowedTools: overrides.allowedTools ?? [],
      mcpServers: overrides.mcpServers ?? {},
      environment: {},
    });
    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as {
      readonly type: string;
      readonly preset: string;
      readonly append?: string;
    };
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.include(systemPrompt.append ?? "", GOAT_DEVELOPMENT_INSTRUCTIONS);
    assert.include(systemPrompt.append ?? "", "## GOAT orchestration");
    assert.include(systemPrompt.append ?? "", "call `goat_background_wait`");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });

  it("redacts settings values from query logs", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "settings-log",
      resume: false,
      cwd: "/workspace",
      sdkSettings: { env: { ANTHROPIC_API_KEY: "secret-settings-key" } },
    });
    assert.notInclude(
      JSON.stringify(ClaudeAdapterV2.loggedClaudeQueryOptions(options)),
      "secret-settings-key",
    );
  });
});
