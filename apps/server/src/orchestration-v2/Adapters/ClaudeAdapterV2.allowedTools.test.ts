import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const threadId = ThreadId.make("thread-claude-allowed-tools");
const mcpSession = {
  environmentId: EnvironmentId.make("environment-claude-allowed-tools"),
  threadId,
  providerSessionId: "mcp-session-claude-allowed-tools",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret",
  browserToolsAvailable: true,
};

it("keeps a user's preapproval of a GOAT tool named as it shipped, under the listed name", () => {
  const allowedTools = [
    "mcp__goat__orchestrator_capabilities",
    "mcp__goat__delegate_task",
    "mcp__goat__goat_thread_read",
    "Bash(git status)",
  ];
  const full = ClaudeAdapterV2.claudeMcpQueryOverrides({
    mcpSession,
    readOnlySandbox: false,
    allowedTools,
  });
  for (const name of ["goat_provider_list", "goat_task_create", "goat_thread_read"])
    assert.include(full.allowedTools ?? [], `mcp__goat__${name}`);
  assert.include(full.allowedTools ?? [], "Bash(git status)");
  assert.notInclude(full.allowedTools ?? [], "mcp__goat__delegate_task");
  // A read-only sandbox still admits only the read-only GOAT tools, now matched by listed name.
  const readOnly = ClaudeAdapterV2.claudeMcpQueryOverrides({
    mcpSession,
    readOnlySandbox: true,
    allowedTools,
  });
  assert.include(readOnly.allowedTools ?? [], "mcp__goat__goat_provider_list");
  assert.notInclude(readOnly.allowedTools ?? [], "mcp__goat__goat_task_create");
});
