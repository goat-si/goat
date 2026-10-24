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

  it("a call still open covers later events for ten seconds at most, and none once its control ends", () => {
    const log = makeAgentInputLog();
    log.started("1", 1_000);
    assert.isTrue(log.isAgents(10_000));
    // A call that never answered stops hiding a person's input.
    assert.isFalse(log.isAgents(12_000));
    assert.isFalse(log.isAgents(2_000, (key) => key !== "1"));
    log.endAll(5_000);
    assert.isFalse(log.isAgents(6_000));
  });

  it("only calls known to read leave a person's input visible; an unknown tool counts as input", () => {
    for (const tool of ["get_window_state", "list_apps", "zoom"]) assert.isFalse(postsInput(tool));
    for (const tool of ["click", "type_text", "run_script", "launch_app", "some_new_tool"])
      assert.isTrue(postsInput(tool));
  });

  it("starts whose end never came, or came first, are forgotten once they cover nothing", () => {
    const log = makeAgentInputLog();
    assert.isFalse(log.ended("early", 1_000));
    log.started("early", 1_000);
    log.started("lost", 1_200);
    log.started("done", 1_300);
    log.ended("done", 1_400);
    log.prune(5_000);
    assert.equal(log.size(), 3);
    log.prune(20_000);
    assert.equal(log.size(), 0);
  });

  it("a call dated in the future erases nobody else's", () => {
    const log = makeAgentInputLog();
    log.started("A", 1_000);
    log.started("B", 20_000);
    log.prune(1_100);
    assert.isTrue(log.isAgents(1_100));
  });
});
