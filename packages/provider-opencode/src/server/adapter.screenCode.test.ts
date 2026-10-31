import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { goatOrchestrationSystemPrompt } from "@goat/provider-core/server/orchestrationInstructions";
import { buildSessionRuntimeInstructions } from "./screenInstructions.ts";

it("puts goat_screen_run in OpenCode's guide when its GOAT MCP session carries screen code", () => {
  const config = {
    environmentId: EnvironmentId.make("env-screen"),
    threadId: ThreadId.make("thread-screen"),
    providerSessionId: "session-screen",
    providerInstanceId: ProviderInstanceId.make("opencode"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer test",
    browserToolsAvailable: true,
    builtInSkills: ["screen-code"] as const,
    screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
  };
  assert.include(
    buildSessionRuntimeInstructions(config, { harness: "OpenCode" }),
    "goat_screen_run",
  );
  const prompt = buildSessionRuntimeInstructions(config, { harness: "OpenCode" });
  assert.include(prompt, "Read the screen-code skill at /state/skills/screen-code/SKILL.md");
  for (const term of [
    "list_windows",
    "get_window_state",
    "get_accessibility_tree",
    "element_token",
    "verify_state",
    "run_steps",
    'since:"latest"',
  ])
    assert.notInclude(prompt, term);
  assert.notInclude(
    buildSessionRuntimeInstructions({ ...config, builtInSkills: [] }, { harness: "OpenCode" }),
    "screen-code",
  );
});

it.each([false, true])("gates browser routing in session instructions, browser=%s", (browser) => {
  assert.equal(goatOrchestrationSystemPrompt(true, browser).includes("## GOAT browser"), browser);
  assert.notInclude(goatOrchestrationSystemPrompt(false, browser), "## GOAT browser");
});
