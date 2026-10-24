import { assert, describe, it } from "@effect/vitest";

import { makeAgentInputLog, postsInput } from "./agentInputLog.ts";

describe("agentInputLog", () => {
  it("an event during or just after the agent's input call is the agent's, later ones a person's", () => {
    const log = makeAgentInputLog();
    log.started("1", 1_000);
    assert.isTrue(log.isAgents(1_200));
    log.ended("1", 1_400);
    assert.isTrue(log.isAgents(1_800));
    assert.isFalse(log.isAgents(2_000));
    // Before the call was sent the person was already typing.
    assert.isFalse(log.isAgents(900));
  });

  it("a call still open covers later events for a minute at most, and none once its control ends", () => {
    const log = makeAgentInputLog();
    log.started("1", 1_000);
    assert.isTrue(log.isAgents(60_000));
    // A call that never answered stops hiding a person's input.
    assert.isFalse(log.isAgents(62_000));
    assert.isFalse(log.isAgents(2_000, (key) => key !== "1"));
    log.endAll(30_000);
    assert.isFalse(log.isAgents(31_000));
  });

  it("only calls known to read leave a person's input visible; an unknown tool counts as input", () => {
    for (const tool of ["get_window_state", "list_apps", "zoom"]) assert.isFalse(postsInput(tool));
    for (const tool of ["click", "type_text", "run_script", "launch_app", "some_new_tool"])
      assert.isTrue(postsInput(tool));
  });
});
