import { assert, describe, it } from "@effect/vitest";

import { inputKinds, makeAgentInputLog, postsInput } from "./agentInputLog.ts";

describe("agentInputLog", () => {
  it("an event of the call's kind during or just after it is the agent's, later ones a person's", () => {
    const log = makeAgentInputLog();
    log.started("1", 1_000, ["pointer"]);
    assert.isTrue(log.isAgents(1_200, "pointer"));
    log.ended("1", 1_400);
    assert.isTrue(log.isAgents(1_800, "pointer"));
    assert.isFalse(log.isAgents(2_000, "pointer"));
    // Before the call was sent the person was already moving the pointer.
    assert.isFalse(log.isAgents(900, "pointer"));
  });

  it("an event of another kind, or of unknown kind, during the call is a person's", () => {
    const log = makeAgentInputLog();
    log.started("click", 1_000, ["pointer"]);
    assert.isFalse(log.isAgents(1_100, "keyboard"));
    assert.isFalse(log.isAgents(1_100, "unknown"));
    // A start from a proxy that names no kinds covers both, as before.
    log.started("old", 1_000);
    assert.isTrue(log.isAgents(1_100, "keyboard"));
  });

  it("a call still open covers later events for ten seconds at most, and none once its control ends", () => {
    const log = makeAgentInputLog();
    log.started("1", 1_000, ["keyboard"]);
    assert.isTrue(log.isAgents(10_000, "keyboard"));
    // A call that never answered stops hiding a person's input.
    assert.isFalse(log.isAgents(12_000, "keyboard"));
    assert.isFalse(log.isAgents(2_000, "keyboard", (key) => key !== "1"));
    log.endAll(5_000);
    assert.isFalse(log.isAgents(6_000, "keyboard"));
  });

  it("an unbroken run of calls of one kind covers ten seconds at most", () => {
    const log = makeAgentInputLog();
    for (let call = 0; call < 30; call++) {
      log.started(String(call), 1_000 + call * 400, ["pointer"]);
      log.ended(String(call), 1_100 + call * 400);
    }
    assert.isTrue(log.isAgents(9_000, "pointer"));
    assert.isFalse(log.isAgents(11_100, "pointer"));
  });

  it("forgetting old calls does not restart an unbroken run", () => {
    // As the server uses it: every report prunes by its own clock, and the helper reports an
    // event a little after it happened.
    const log = makeAgentInputLog();
    for (let call = 0; call < 60; call++) {
      const now = 1_000 + call * 400;
      log.prune(now);
      log.started(String(call), now, ["pointer"]);
      log.ended(String(call), now + 100);
      if (now > 12_000) assert.isFalse(log.isAgents(now - 300, "pointer"), String(now));
    }
  });

  it("names the kinds a call can post from its tool and arguments", () => {
    for (const tool of ["get_window_state", "list_apps", "zoom", "invoke_menu", "launch_app"])
      assert.isFalse(postsInput(tool));
    assert.deepEqual(inputKinds("click", { x: 1, y: 1 }), ["pointer"]);
    assert.deepEqual(inputKinds("click", { modifier: ["shift"] }), ["pointer", "keyboard"]);
    assert.deepEqual(inputKinds("drag", { modifier: ["option"] }), ["pointer", "keyboard"]);
    // Without a point, scroll focuses the element and presses Page Down or arrow keys.
    assert.deepEqual(inputKinds("scroll", { direction: "down", by: "page" }), ["keyboard"]);
    assert.deepEqual(inputKinds("scroll", { direction: "down", x: 5, y: 5 }), ["pointer"]);
    assert.deepEqual(inputKinds("type_text", { text: "a" }), ["keyboard"]);
    assert.deepEqual(inputKinds("type_text", { text: "a", x: 1, y: 1 }), ["keyboard", "pointer"]);
    for (const tool of ["run_script", "run_steps", "some_new_tool"])
      assert.deepEqual(inputKinds(tool), ["keyboard", "pointer"]);
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
    assert.isTrue(log.isAgents(1_100, "pointer"));
  });
});
