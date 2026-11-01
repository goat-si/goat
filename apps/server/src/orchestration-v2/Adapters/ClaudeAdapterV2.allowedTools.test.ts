import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import * as ClaudeRuntimeSkills from "./ClaudeRuntimeSkills.ts";

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

it("includes goat_screen_run in Claude's guide when screen code is attached", () => {
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-5",
    },
    nativeThreadId: "native-screen-code",
    resume: false,
    cwd: "/workspace",
    ...ClaudeRuntimeSkills.skillOptions({
      ...mcpSession,
      builtInSkills: ["screen-code"],
      screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
    }),
    mcpServers: {
      goat: {
        type: "http",
        url: mcpSession.endpoint,
        headers: { Authorization: mcpSession.authorizationHeader },
      },
    },
  });
  assert.include(JSON.stringify(options.systemPrompt), "goat_screen_run");
  assert.include(
    JSON.stringify(options.systemPrompt),
    "Read the screen-code skill at /state/skills/screen-code/SKILL.md",
  );
  assert.isDefined(options.mcpServers?.goat);
  for (const term of [
    "list_windows",
    "get_window_state",
    "get_accessibility_tree",
    "element_token",
    "verify_state",
    "run_steps",
    'since:"latest"',
  ])
    assert.notInclude(JSON.stringify(options.systemPrompt), term);
});

it("omits screen guidance when the skill is disabled, including driver-only turns", () => {
  for (const driver of [false, true]) {
    const session = {
      ...mcpSession,
      builtInSkills: driver ? ["computer-use" as const] : [],
      screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
    };
    const text = ClaudeRuntimeSkills.runtimeInstructions({
      ...ClaudeRuntimeSkills.skillOptions(session),
      mcpServers: driver ? { "cua-driver": { command: "driver" } } : {},
    });
    assert.notInclude(text, "<screen_code>");
    assert.notInclude(text, "/state/skills/screen-code/SKILL.md");
    assert.equal(text.includes("list_windows"), driver);
  }
});

it.each([undefined, false, true])(
  "gates browser routing in the system prompt, browser=%s",
  (browserToolsAvailable) => {
    const session =
      browserToolsAvailable === undefined ? undefined : { ...mcpSession, browserToolsAvailable };
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: { instanceId: mcpSession.providerInstanceId, model: "test-model" },
      nativeThreadId: "browser-guidance",
      resume: false,
      cwd: "/workspace",
      ...ClaudeRuntimeSkills.skillOptions(session),
      ...ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false }),
    });
    assert.equal(
      JSON.stringify(options.systemPrompt).includes("## GOAT browser"),
      browserToolsAvailable === true,
    );
  },
);
