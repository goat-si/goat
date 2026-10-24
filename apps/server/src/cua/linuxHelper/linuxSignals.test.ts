import { describe, expect, it } from "vite-plus/test";

import type { ComputerUseEvent } from "@goat/contracts";

import type { SecureFocus } from "./atspiFocus.ts";
import type { HumanInput, HumanInputSource } from "./humanInputSource.ts";
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
    // Input before the watch started is not its concern.
    helper.personInput.latest = { order: 1, source: "keyboard" };
    helper.clock.now = 1_000;
    await watch(helper, "w1");
    await helper.events();
    await helper.tick();
    helper.personInput.latest = { order: 2, source: "pointer" };
    helper.clock.now = 1_200;
    await helper.tick();
    helper.personInput.latest = { order: 3, source: "keyboard" };
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

  it("input is ordered by arrival, so a wall clock stepping back hides nothing", async () => {
    const helper = await connect();
    helper.personInput.latest = { order: 5, source: "pointer" };
    helper.clock.now = 10_000;
    await watch(helper, "w1");
    await helper.events();
    // The system clock steps back an hour; the helper's clock is monotonic and does not, and a
    // person's new input still follows the input seen before the watch.
    helper.personInput.latest = { order: 6, source: "keyboard" };
    helper.clock.now = 10_050;
    await helper.tick();
    expect((await helper.events()).at(-1)).toMatchObject({
      event: { type: "humanInput", source: "keyboard" },
    });
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
    helper.personInput.latest = { order: 1, source: "keyboard" };
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
function monitor(
  options: {
    readonly windowOpen?: () => Promise<boolean | undefined>;
    readonly secureFocus?: (pid: number) => Promise<SecureFocus>;
    readonly input?: HumanInputSource;
  } = {},
) {
  const limit = Promise.withResolvers<void>();
  const lostCalls = { count: 0 };
  const focus: { current: SecureFocus } = { current: NOT_SECURE };
  const events: Array<{ watchId: string; event: ComputerUseEvent }> = [];
  const deferred: Array<() => Promise<void>> = [];
  const armed = new Set<() => Promise<void>>();
  const arming = { count: 0 };
  const signals = makeSignalMonitor({
    secureFocus: options.secureFocus ?? (async () => focus.current),
    windowOpen: options.windowOpen ?? (async () => true),
    input: options.input,
    inputLost: () => void lostCalls.count++,
    delay: () => limit.promise,
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
  return {
    signals,
    focus,
    events,
    runDeferred,
    tick,
    armed,
    arming,
    lostCalls,
    /** Ends every focus probe still waiting, as its time limit would. */
    expireProbes: () => limit.resolve(),
  };
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

  it("a check left over from an earlier watch never lets a second probe of the same window run", async () => {
    const probes: Array<PromiseWithResolvers<SecureFocus>> = [];
    const third = Promise.withResolvers<void>();
    const m = monitor({
      secureFocus: () => {
        const probe = Promise.withResolvers<SecureFocus>();
        if (probes.push(probe) === 3) third.resolve();
        return probe.promise;
      },
    });
    await m.signals.watch("a", [target]);
    const earlier = m.runDeferred();
    await m.signals.unwatch();
    await m.signals.watch("b", [target]);
    const current = m.runDeferred();
    // Watch a's probe answers late, while watch b's first probe is still out.
    probes[0]?.resolve(secure);
    await earlier;
    // The tick either skips the window being checked or starts a third, racing probe.
    await Promise.race([m.tick(), third.promise]);
    expect(probes).toHaveLength(2);
    probes[1]?.resolve(secure);
    await current;
    expect(m.events.filter((entry) => entry.watchId === "b")).toEqual([
      { watchId: "b", event: { type: "privateMode", active: true, target } },
    ]);
  });

  it("one window's slow focus probe holds back no other signal", async () => {
    const a = { pid: 10, windowId: 20 };
    const b = { pid: 11, windowId: 21 };
    const input: { latest: HumanInput | undefined; lost: boolean } = {
      latest: undefined,
      lost: false,
    };
    const m = monitor({
      // Window b's probe never answers; a's password field has focus.
      secureFocus: (pid) =>
        pid === b.pid ? new Promise<SecureFocus>(() => undefined) : Promise.resolve(secure),
      input: { latest: () => input.latest, lost: () => input.lost, close: () => undefined },
    });
    await m.signals.watch("w", [a, b]);
    // The deferred start waits for b's first report, which never comes; it is not awaited.
    void m.runDeferred();
    await m.tick();
    expect(m.events).toContainEqual({
      watchId: "w",
      event: { type: "privateMode", active: true, target: a },
    });
    input.latest = { order: 1, source: "keyboard" };
    await m.tick();
    expect(m.events).toContainEqual({
      watchId: "w",
      event: { type: "humanInput", source: "keyboard" },
    });
    input.lost = true;
    await m.tick();
    expect(m.lostCalls.count).toBe(1);
    // When b's probe runs out of time, b counts as private.
    m.expireProbes();
    await m.tick();
    expect(m.events).toContainEqual({
      watchId: "w",
      event: { type: "privateMode", active: true, target: b },
    });
  });
});
