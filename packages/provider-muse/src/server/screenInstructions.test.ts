import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  testLayer,
  INSTANCE_ID,
  THREAD_ID,
  makeFakeMuse,
  makeHarness,
  turnInput,
} from "./test/adapterHelpers.ts";

it.effect.each([true, false])("gates screen guidance by the turn skill, enabled=%s", (enabled) =>
  Effect.gen(function* () {
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make("test-environment"),
      threadId: THREAD_ID,
      providerSessionId: "test-session",
      providerInstanceId: INSTANCE_ID,
      endpoint: "http://127.0.0.1:43210/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
      builtInSkills: enabled ? ["screen-code"] : [],
      screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
    });
    const fake = yield* makeFakeMuse();
    fake.host.initializeResult.grantedCapabilities.push("sessionMcp");
    const harness = yield* makeHarness(fake);
    yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread));
    const call = yield* fake.takeCall("turn/start");
    const text = JSON.stringify(call.params.input);
    assert.equal(
      text.includes("Read the screen-code skill at /state/skills/screen-code/SKILL.md"),
      enabled,
    );
    assert.equal(text.includes("goat_screen_run"), enabled);
    for (const term of [
      "list_windows",
      "get_window_state",
      "get_accessibility_tree",
      "element_token",
      "verify_state",
      "run_steps",
      'since:"latest"',
    ])
      assert.notInclude(text, term);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
