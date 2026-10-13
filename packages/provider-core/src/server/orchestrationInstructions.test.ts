import { assert, describe, it } from "@effect/vitest";

import {
  GOAT_ORCHESTRATION_INSTRUCTIONS,
  goatAcpPromptWithInstructions,
  goatOrchestrationPromptForFirstRun,
  goatOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("instructs every provider to write GOAT thread links", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "[title](goat-thread://v1/<threadId>)");
    assert.notInclude(GOAT_ORCHESTRATION_INSTRUCTIONS, "t3-thread://");
  });

  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level GOAT conversations");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "never use these tools merely");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      GOAT_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `goat_thread_send` on `childThreadId`",
    );
  });

  it("sends goal-owning and looping work to a top-level thread", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "bounded child work");
    assert.include(
      GOAT_ORCHESTRATION_INSTRUCTIONS,
      "for work that owns a goal, runs a loop (HOTL, `cxc-loop`, repeated PABCD), or spans several cycles",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = goatOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasGoatMcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      goatOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasGoatMcp: true }),
      prompt,
    );
    assert.equal(
      goatOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasGoatMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(goatOrchestrationSystemPrompt(false), undefined);
    assert.equal(goatOrchestrationSystemPrompt(true), GOAT_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = goatAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasGoatMcp: true },
    });

    assert.include(injected, "GOAT interaction mode: Default");
    assert.include(injected, "GOAT collaborative browser");
    assert.include(injected, "GOAT orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasGoatMcp: true } as const;

    assert.equal(
      goatAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      goatAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "GOAT interaction mode: Plan",
    );
    const withoutMcp = goatAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasGoatMcp: false },
    });
    assert.include(withoutMcp, "GOAT interaction mode: Default");
    assert.notInclude(withoutMcp, "GOAT collaborative browser");
    assert.notInclude(withoutMcp, "GOAT orchestration");
  });
});

it("explains question decisions and question-aware waits", () => {
  for (const text of [
    "goat_pending_request_respond",
    "reason",
    "human-only",
    "never sleep-poll",
    "end the turn",
    "pendingRequestIds",
    'scope:"launched"',
    "also with `host`",
    "here or on hosts arrive as notifications",
    "`host` for remote threads",
    "Only local user-input questions still arrive.",
    'SSH-host questions then need `goat_thread_wait({host})` or `goat_pending_request_list({scope:"launched", hosts})`. Approvals are no longer reported; check `goat_thread_read` or tell the user the thread may be waiting.',
    "Forward to the user any decision your own user has not authorized, such as pushing, deploying, sending outside, or starting new work beyond the request.",
  ]) {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, text);
  }
});
