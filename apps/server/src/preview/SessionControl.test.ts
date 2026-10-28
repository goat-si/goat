import { describe, expect, it } from "vite-plus/test";

import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";

describe("SessionControl", () => {
  it("rejects a page action after its expected control generation changes", async () => {
    const control = new SessionControl("agent");
    const gate = control.dispatchGate(control.generation);
    await control.take("person");
    await control.release("person");
    expect(() => gate()).toThrow(BrowserControlInterrupted);
    expect(() => control.assertObservedGeneration(0)).toThrow(BrowserControlInterrupted);
  });
  it("returns an action result before tracked navigation but drains it before already queued actions", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    const events: string[] = [];
    const navigation = control.agent("agent", async () => {
      control.track(committed.promise.then(() => events.push("navigation committed")));
      return "started";
    });
    const next = control.agent("agent", async () => events.push("next action"));
    await expect(navigation).resolves.toBe("started");
    expect(events).toEqual([]);
    committed.resolve();
    await next;
    expect(events).toEqual(["navigation committed", "next action"]);
  });

  it("handles tracked navigation failures without poisoning the next action", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    await control.agent("agent", async () => control.track(committed.promise));
    committed.reject(new Error("navigation failed"));
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
  });

  it("only lets the assigned agent act and restores that agent after human control", async () => {
    const control = new SessionControl("agent-a");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.agent("agent-a", async () => "first")).resolves.toBe("first");
    await control.take("viewer-a");
    await expect(control.agent("agent-a", async () => "racing")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.human("viewer-a", async () => "typed")).resolves.toBe("typed");
    await control.release("viewer-a");
    await expect(control.agent("agent-a", async () => "resumed")).resolves.toBe("resumed");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
  });

  it("drains running work before takeover and cancels previously queued agent actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.agent("agent", async () => {
      events.push("agent started");
      started.resolve();
      await finish.promise;
      events.push("agent finished");
    });
    await started.promise;
    const queued = expect(
      control.agent("agent", async () => events.push("stale agent action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    const takeover = control.take("viewer");
    const typing = control.human("viewer", async () => events.push("human typed"));
    await expect(control.agent("agent", async () => "late action")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    expect(events).toEqual(["agent started"]);
    finish.resolve();
    await Promise.all([running, queued, takeover, typing]);
    expect(events).toEqual(["agent started", "agent finished", "human typed"]);
  });

  it("does not let a second viewer steal, type, release, or disconnect the owner", async () => {
    const control = new SessionControl("agent");
    const takeover = control.take("viewer-a");
    await expect(control.take("viewer-b")).rejects.toThrow("Another viewer");
    await takeover;
    await expect(control.human("viewer-b", async () => "wrong viewer")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.release("viewer-b")).rejects.toThrow("Only the controlling viewer");
    await control.disconnect("viewer-b");
    expect(control.controller).toBe("viewer-a");
    await expect(control.human("viewer-a", async () => "still controlled")).resolves.toBe(
      "still controlled",
    );
  });

  it("invalidates queued human actions and refs when a viewer disconnects", async () => {
    let invalidations = 0;
    const control = new SessionControl("agent", () => invalidations++);
    await control.take("viewer");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.human("viewer", async () => {
      started.resolve();
      await finish.promise;
      events.push("human finished");
    });
    await started.promise;
    const queued = expect(
      control.human("viewer", async () => events.push("stale human action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    const disconnected = control.disconnect("viewer");
    const resumed = control.agent("agent", async () => events.push("agent resumed"));
    expect(control.generation).toBe(2);
    expect(invalidations).toBe(2);
    finish.resolve();
    await Promise.all([running, queued, disconnected, resumed]);
    expect(events).toEqual(["human finished", "agent resumed"]);
  });

  it("does not revive stale actions when takeover is released before running work finishes", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const staleAgent = expect(control.agent("agent", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const takeover = expect(control.take("viewer")).rejects.toThrow(BrowserControlInterrupted);
    const staleHuman = expect(control.human("viewer", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const release = control.release("viewer");
    const resumed = control.agent("agent", async () => "fresh");
    finish.resolve();
    await Promise.all([running, staleAgent, takeover, staleHuman, release]);
    await expect(resumed).resolves.toBe("fresh");
  });

  it("closes after running work finishes and never runs queued or new actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
      return "finished";
    });
    await started.promise;
    const queued = expect(control.agent("agent", async () => "stale")).rejects.toThrow("closed");
    const closed = control.close();
    await expect(control.take("viewer")).rejects.toThrow("closed");
    await expect(control.agent("agent", async () => "new")).rejects.toThrow("closed");
    finish.resolve();
    await expect(running).resolves.toBe("finished");
    await Promise.all([queued, closed]);
    await control.disconnect("viewer");
    await control.close();
    expect(control.generation).toBe(1);
  });

  it("lets any agent act on a tab no agent opened, but only while no human controls it", async () => {
    const control = new SessionControl(null);
    await expect(control.agent("agent-a", async () => "acted")).resolves.toBe("acted");
    await control.take("viewer-a");
    await expect(control.agent("agent-a", async () => "racing")).rejects.toMatchObject({
      reason: "humanControl",
    });
    await expect(control.observe(async () => "read")).resolves.toBe("read");
    await control.release("viewer-a");
    await expect(control.agent("agent-b", async () => "acted")).resolves.toBe("acted");
  });

  it("refuses agent actions and observation while private, and interrupts the action under way", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const running = control.agent("agent", (signal) => {
      started.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    });
    await started.promise;
    const generation = control.generation;
    control.setPrivate(true);
    await expect(running).rejects.toMatchObject({ reason: "privateMode" });
    expect(control.generation).toBeGreaterThan(generation);
    await expect(control.agent("agent", async () => "click")).rejects.toMatchObject({
      reason: "privateMode",
    });
    // A person driving the tab does not open it to agent reads while a secret is on screen.
    await control.take("viewer");
    await expect(control.observe(async () => "snapshot")).rejects.toMatchObject({
      reason: "privateMode",
    });
    await expect(control.human("viewer", async () => "typed")).resolves.toBe("typed");
    control.setPrivate(false);
    await expect(control.observe(async () => "snapshot")).resolves.toBe("snapshot");
  });

  it("keeps agents out after a person's stop until they hand the tab back", async () => {
    const control = new SessionControl("agent");
    const changes: Array<boolean> = [];
    control.onChange(() => changes.push(control.isAgentStopped));
    control.stopAgents();
    await expect(control.agent("agent", async () => "click")).rejects.toMatchObject({
      reason: "stopped",
    });
    expect(control.agentCanActNow("agent")).toBe(false);
    // Reads still work: a stopped agent may look, not act.
    await expect(control.observe(async () => "snapshot")).resolves.toBe("snapshot");
    control.resumeAgents();
    await expect(control.agent("agent", async () => "click")).resolves.toBe("click");
    expect(changes).toEqual([true, false]);
  });

  it("marks a refusal raised before input, and leaves a cut after the gate unmarked", async () => {
    const control = new SessionControl("agent");
    control.stopAgents();
    await expect(control.agent("agent", async () => "click")).rejects.toMatchObject({
      reason: "stopped",
      beforeInput: true,
    });
    control.resumeAgents();
    const gate = control.dispatchGate();
    await control.take("person");
    await control.release("person");
    expect(() => gate()).toThrow(expect.objectContaining({ beforeInput: true }));
    const started = Promise.withResolvers<void>();
    const acting = control.agent("agent", () => {
      control.dispatchGate()();
      started.resolve();
      return new Promise<never>(() => {});
    });
    await started.promise;
    control.stopAgents();
    await expect(acting).rejects.toMatchObject({ reason: "stopped", beforeInput: false });
  });

  it("answers a stopped action at once even when its work ignores the signal, and keeps later actions behind that work", async () => {
    const control = new SessionControl("agent");
    const work = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const events: Array<string> = [];
    const stuck = control.agent("agent", () => {
      started.resolve();
      return work.promise;
    });
    await started.promise;
    control.stopAgents();
    await expect(stuck).rejects.toMatchObject({ reason: "stopped" });
    expect(() => control.assertAgentMayDispatch()).toThrow(BrowserControlInterrupted);
    control.resumeAgents();
    const next = control.agent("agent", async () => events.push("next"));
    work.resolve("late click");
    await next;
    expect(events).toEqual(["next"]);
  });

  it("withholds what an observation read when a secret appeared before it returned", async () => {
    const control = new SessionControl("agent");
    const read = Promise.withResolvers<string>();
    const observing = control.observe(() => read.promise);
    control.setPrivate(true);
    read.resolve("snapshot with the password field");
    await expect(observing).rejects.toMatchObject({ reason: "privateMode" });
  });

  it("holds input from a gate passed before the action returned, and from a click left on a dialog", async () => {
    const control = new SessionControl("agent");
    const held: Array<Promise<unknown>> = [];
    control.onDispatchCut((work) => held.push(work));
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const lateClick = Promise.withResolvers<void>();
    const acting = control.agent("agent", () => {
      // A key press passes its gate synchronously, before run() returns its promise.
      const gate = control.dispatchGate();
      gate();
      gate.linger(lateClick.promise);
      started.resolve();
      return finish.promise;
    });
    await started.promise;
    control.setPrivate(true);
    expect(held).toHaveLength(2);
    await expect(acting).rejects.toMatchObject({ reason: "privateMode" });
    finish.resolve();
    // The action is over, but the click it left on the dialog is still covered.
    control.setPrivate(false);
    control.stopAgents();
    expect(held).toHaveLength(3);
    lateClick.resolve();
  });

  it("keeps an action's input cancelled after a brief secret ends", async () => {
    const control = new SessionControl("agent");
    const gate = control.dispatchGate();
    control.setPrivate(true);
    control.setPrivate(false);
    expect(control.agentCanActNow("agent")).toBe(true);
    expect(gate).toThrow(BrowserControlInterrupted);
    expect(control.dispatchGate()).not.toThrow();
  });

  it("withholds a read that a brief secret overlapped, even after the secret is gone", async () => {
    const control = new SessionControl("agent");
    const read = Promise.withResolvers<string>();
    const observing = control.observe(() => read.promise);
    control.setPrivate(true);
    control.setPrivate(false);
    read.resolve("frame that showed the password field");
    await expect(observing).rejects.toMatchObject({ reason: "privateMode" });
    await expect(control.observe(async () => "next read")).resolves.toBe("next read");
  });

  it("runs secret work while private and does not cut it when privacy changes during the run", async () => {
    const control = new SessionControl("agent");
    control.setPrivate(true);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.secret("agent", async ({ assertMayDispatch }) => {
      expect(control.isPrivate).toBe(true);
      started.resolve();
      await finish.promise;
      assertMayDispatch();
      return "filled";
    });
    await started.promise;
    control.setPrivate(false);
    control.setPrivate(true);
    finish.resolve();
    await expect(running).resolves.toBe("filled");
  });

  it("holds privacy until secret work ends and withholds observations overlapping the hold after release", async () => {
    const control = new SessionControl("agent");
    const read = Promise.withResolvers<string>();
    const observing = control.observe(() => read.promise);
    const held = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.secret("agent", async ({ hold }) => {
      hold();
      hold();
      held.resolve();
      await finish.promise;
    });
    await held.promise;
    control.setPrivate(false);
    expect(control.isPrivate).toBe(true);
    await expect(control.observe(async () => "private frame")).rejects.toMatchObject({
      reason: "privateMode",
    });
    finish.resolve();
    await running;
    expect(control.isPrivate).toBe(false);
    read.resolve("frame from during the fill");
    await expect(observing).rejects.toMatchObject({ reason: "privateMode" });
    await expect(control.observe(async () => "fresh frame")).resolves.toBe("fresh frame");
  });

  it("keeps secret dispatch refused after a takeover is released during the run", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.secret("agent", async ({ assertMayDispatch }) => {
      assertMayDispatch();
      started.resolve();
      await finish.promise;
      expect(control.controller).toBe(null);
      expect(assertMayDispatch).toThrow(BrowserControlInterrupted);
    });
    await started.promise;
    const takeover = expect(control.take("viewer")).rejects.toThrow(BrowserControlInterrupted);
    const released = control.release("viewer");
    finish.resolve();
    await Promise.all([running, takeover, released]);
    await expect(control.secret("agent", async () => "fresh fill")).resolves.toBe("fresh fill");
  });

  it("keeps secret dispatch refused after agents stop and resume during the run", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.secret("agent", async ({ assertMayDispatch }) => {
      assertMayDispatch();
      started.resolve();
      await finish.promise;
      expect(control.isAgentStopped).toBe(false);
      expect(assertMayDispatch).toThrow(BrowserControlInterrupted);
    });
    await started.promise;
    control.stopAgents();
    control.resumeAgents();
    finish.resolve();
    await running;
    await expect(control.secret("agent", async () => "fresh fill")).resolves.toBe("fresh fill");
  });

  it("refuses secret work before dispatch under human control, Stop, or another agent", async () => {
    const control = new SessionControl("agent");
    const dispatched: string[] = [];
    const run = async () => {
      dispatched.push("filled");
    };
    await control.take("viewer");
    await expect(control.secret("agent", run)).rejects.toMatchObject({ reason: "humanControl" });
    await control.release("viewer");
    control.stopAgents();
    await expect(control.secret("agent", run)).rejects.toMatchObject({ reason: "stopped" });
    control.resumeAgents();
    await expect(control.secret("other-agent", run)).rejects.toMatchObject({
      reason: "agentMismatch",
    });
    expect(dispatched).toEqual([]);
  });

  it("holds a tab an agent handed to a person until their hand back is recorded, not when their viewer drops", async () => {
    const control = new SessionControl("agent");
    const changes: string[] = [];
    control.onHandoffChange((change) => changes.push(change));
    const before = control.generation;
    expect(control.requestHandoff("Sign in with the code on your phone.")).toBe(true);
    // Refs the agent took before asking expire, as at a takeover.
    expect(control.generation).toBeGreaterThan(before);
    await expect(control.agent("agent", async () => "typed")).rejects.toMatchObject({
      reason: "humanControl",
    });
    await expect(control.secret("agent", async () => "filled")).rejects.toMatchObject({
      reason: "humanControl",
    });
    await control.take("viewer");
    await control.disconnect("viewer");
    expect([control.handoffReason, changes]).toEqual([
      "Sign in with the code on your phone.",
      ["taken"],
    ]);
    await control.take("viewer");
    await control.release("viewer");
    // Held until the hand back is recorded, which then ends it without reporting it again.
    expect([control.handoffReason, changes]).toEqual([
      "Sign in with the code on your phone.",
      ["taken", "taken", "handedBack"],
    ]);
    expect(control.agentCanActNow("agent")).toBe(false);
    control.endHandoff(null);
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
    control.requestHandoff("Solve the CAPTCHA.");
    control.stopAgents();
    expect([control.handoffReason, changes.at(-1)]).toEqual([null, "stopped"]);
  });

  it("lets the request's own end free the tab without reporting a person's hand back", async () => {
    const control = new SessionControl("agent");
    const ends: string[] = [];
    control.onHandoffChange((end) => ends.push(end));
    control.requestHandoff("Approve the sign-in.");
    control.endHandoff(null);
    expect(ends).toEqual([]);
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
  });
  it("refuses an agent's dialog answer or close on a tab it handed to a person", () => {
    const control = new SessionControl("agent");
    control.assertNoHumanControl();
    control.requestHandoff("Decide whether to trust this device.", "handoff:dialog");
    expect(() => control.assertNoHumanControl()).toThrow(
      expect.objectContaining({ reason: "humanControl" }),
    );
    control.endHandoff(null);
    control.assertNoHumanControl();
  });
});
