import { assert, describe, it } from "@effect/vitest";
import {
  GOAT_ORCHESTRATION_INSTRUCTIONS,
  GOAT_ORCHESTRATION_SECTIONS,
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

  it("spreads work across connected machines", () => {
    for (const text of [
      "### Spread work across machines",
      "`goat_host_status`",
      "`goat_ssh_host_list`",
      "`goat_host_link_list`",
      "`goat_cloud_machine_list`",
      "`goat_provider_host_matrix`",
      "`goat_ssh_thread_launch` and a worktree",
      "the user's browser, local files, signed-in desktop apps",
      "Cordoned or Draining",
      "Do not keep retrying a host that stopped answering",
      "Do not create or resume a Boat cloud machine",
      "which host ran what",
    ]) {
      assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, text);
    }
  });

  it("keeps every section under Codex's per-entry limit", () => {
    for (const section of GOAT_ORCHESTRATION_SECTIONS) {
      assert.isBelow(new TextEncoder().encode(section).length, 4000);
    }
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

it("asks agents to check host pressure before heavy lanes", () => {
  assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "`goat_host_status` with `placement:{}`");
  assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, '"Resource pressure:"');
});
