import { describe, expect, it } from "vite-plus/test";

import type { ComputerUseEvent } from "@goat/contracts";

import type { SecureFocus } from "./atspiFocus.ts";
import { connect, NOT_SECURE, X11 } from "./LinuxComputerUseHelper.testkit.ts";
import { makeSignalMonitor } from "./linuxSignals.ts";

describe("Linux safety signals", () => {
  const target = { pid: 10, windowId: 20 };
  const watch = (helper: Awaited<ReturnType<typeof connect>>, watchId: string) =>
    helper.request("watch", { watchId, targets: [target] });

  it("names both signals in capabilities, and humanInput is unsupported when no person's input can be seen", async () => {
    const withIdle = await connect();
    expect(withIdle.hello).toMatchObject({
      capabilities: { signals: { privateMode: "supported", humanInput: "supported" } },
    });
    await withIdle.close();
    const without = await connect({ personInput: false });
    expect(without.hello).toMatchObject({
      capabilities: { signals: { privateMode: "supported", humanInput: "unsupported" } },
    });
    await without.close();
    const headless = await connect({ session: { ...X11, display: undefined } });
    expect(headless.hello).toMatchObject({
      capabilities: { signals: { privateMode: "unsupported", humanInput: "unsupported" } },
    });
    await headless.close();
  });

  it("reads nothing until watched, then reports every target once after the reply", async () => {
    const helper = await connect();
    expect(helper.armed()).toBe(0);
    const reply = await watch(helper, "w1");
    expect(reply.result).toEqual({ watchId: "w1", watching: [target] });
    expect(await helper.events()).toEqual([
      { generation: "g1", watchId: "w1", event: { type: "privateMode", active: false, target } },
    ]);
    const replyAt = helper.log.findIndex((entry) => entry.id === reply.id);
    const eventAt = helper.log.findIndex((entry) => "event" in entry);
    expect(eventAt).toBeGreaterThan(replyAt);
    await helper.close();
  });

  it("reports a password field taking and leaving focus once each", async () => {
    const helper = await connect();
    await watch(helper, "w1");
    await helper.events();
    helper.focus.current = { known: true, secure: true, windows: 1 };
    await helper.tick();
    await helper.tick();
    helper.focus.current = NOT_SECURE;
    await helper.tick();
    const states = (await helper.events()).map(
      (entry) => (entry.event as { active?: boolean }).active,
    );
    expect(states).toEqual([false, true, false]);
    await helper.close();
  });

  it("clears an active target under the old watch before answering the watch that drops it", async () => {
    const helper = await connect({ focus: { known: true, secure: true, windows: 1 } });
    await watch(helper, "w1");
    await helper.events();
    const other = { pid: 11, windowId: 21 };
    const reply = await helper.request("watch", { watchId: "w2", targets: [other] });
    const clearAt = helper.log.findIndex(
      (entry) => entry.watchId === "w1" && (entry.event as { active?: boolean }).active === false,
    );
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(helper.log.findIndex((entry) => entry.id === reply.id));
    await helper.close();
  });

  it("clears an active target before answering unwatch, and stops reading", async () => {
    const helper = await connect({ focus: { known: true, secure: true, windows: 1 } });
    await watch(helper, "w1");
    await helper.events();
    const reply = await helper.request("unwatch", {});
    const clearAt = helper.log.findIndex(
      (entry) => entry.watchId === "w1" && (entry.event as { active?: boolean }).active === false,
    );
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(helper.log.findIndex((entry) => entry.id === reply.id));
    expect(helper.armed()).toBe(0);
    await helper.close();
  });

  it("a driver error listing windows does not count as the window closing", async () => {
    const helper = await connect({ focus: { known: true, secure: true, windows: 1 } });
    await watch(helper, "w1");
    await helper.events();
    helper.driver.state.nextListError = true;
    await helper.tick();
    const states = (await helper.events()).map(
      (entry) => (entry.event as { active?: boolean }).active,
    );
    expect(states).toEqual([true]);
    await helper.close();
  });

  it("clears an active target whose window closed and stops watching it", async () => {
    const helper = await connect({ focus: { known: true, secure: true, windows: 1 } });
    await watch(helper, "w1");
    await helper.events();
    helper.driver.state.windowOpen = false;
    await helper.tick();
    const last = (await helper.events()).at(-1);
    expect(last).toMatchObject({
      watchId: "w1",
      event: { type: "privateMode", active: false, target },
    });
    await helper.close();
  });

  it("reports a person's input once per burst, with its device kind", async () => {
    const helper = await connect();
    helper.clock.now = 1_000;
    await watch(helper, "w1");
    await helper.events();
    // Input before the watch started is not its concern.
    helper.personInput.latest = { at: 500, source: "keyboard" };
    await helper.tick();
    helper.personInput.latest = { at: 1_100, source: "pointer" };
    helper.clock.now = 1_200;
    await helper.tick();
    helper.personInput.latest = { at: 1_300, source: "keyboard" };
    helper.clock.now = 1_400;
    await helper.tick();
    const inputs = (await helper.events()).filter(
      (entry) => (entry.event as { type: string }).type === "humanInput",
    );
    expect(inputs).toEqual([
      { generation: "g1", watchId: "w1", event: { type: "humanInput", source: "pointer" } },
    ]);
    await helper.close();
  });

  it("a person's input right after the helper's own action is still reported", async () => {
    const helper = await connect();
    const first = await helper.observe();
    await watch(helper, "w1");
    await helper.events();
    helper.clock.now = 1_000;
    await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    // The source already leaves out the helper's own devices; this is a person's.
    helper.personInput.latest = { at: 1_200, source: "keyboard" };
    helper.clock.now = 1_250;
    await helper.tick();
    expect((await helper.events()).at(-1)).toMatchObject({
      event: { type: "humanInput", source: "keyboard" },
    });
    await helper.close();
  });

  it("when the input source breaks, the watch pauses agents once and tells the helper", async () => {
    const helper = await connect();
    await watch(helper, "w1");
    await helper.events();
    helper.personInput.lost = true;
    await helper.tick();
    await helper.tick();
    const inputs = (await helper.events()).filter(
      (entry) => (entry.event as { type: string }).type === "humanInput",
    );
    expect(inputs).toEqual([
      { generation: "g1", watchId: "w1", event: { type: "humanInput", source: "unknown" } },
    ]);
    expect(helper.personInput.lostCalls).toBe(1);
    await helper.close();
  });
});

/** A monitor on its own, with the work it defers and the checks it arms in the test's hands. */
function monitor(options: { readonly windowOpen?: () => Promise<boolean | undefined> } = {}) {
  const focus: { current: SecureFocus } = { current: NOT_SECURE };
  const events: Array<{ watchId: string; event: ComputerUseEvent }> = [];
  const deferred: Array<() => Promise<void>> = [];
  const armed = new Set<() => Promise<void>>();
  const arming = { count: 0 };
  const signals = makeSignalMonitor({
    secureFocus: async () => focus.current,
    windowOpen: options.windowOpen ?? (async () => true),
    input: undefined,
    inputLost: () => undefined,
    now: () => 0,
    every: (_ms, task) => {
      arming.count++;
      armed.add(task);
      return () => armed.delete(task);
    },
    afterReply: (task) => void deferred.push(task),
    emit: (watchId, event) => events.push({ watchId, event }),
  });
  const runDeferred = async () => {
    for (const task of deferred.splice(0)) await task();
  };
  const tick = async () => {
    for (const task of Array.from(armed)) await task();
  };
  return { signals, focus, events, runDeferred, tick, armed, arming };
}

describe("makeSignalMonitor", () => {
  const target = { pid: 10, windowId: 20 };
  const secure: SecureFocus = { known: true, secure: true, windows: 1 };

  it("a target a new watch keeps stays active until read, so an early unwatch still clears it", async () => {
    const m = monitor();
    m.focus.current = secure;
    await m.signals.watch("a", [target]);
    await m.runDeferred();
    await m.signals.watch("b", [target]);
    // Unwatch before watch b's first reading runs.
    await m.signals.unwatch();
    expect(m.events.at(-1)).toEqual({
      watchId: "b",
      event: { type: "privateMode", active: false, target },
    });
  });

  it("work deferred by an earlier watch with the same id never arms a second set of checks", async () => {
    const m = monitor();
    await m.signals.watch("a", [target]);
    await m.signals.unwatch();
    await m.signals.watch("a", [target]);
    await m.runDeferred();
    // One focus check for the live watch; the first watch's deferred start does nothing.
    expect(m.arming.count).toBe(1);
  });
});
