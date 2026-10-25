import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_PROTOCOL_VERSION,
  computerUseReady,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeLinuxHelper } from "./LinuxComputerUseHelper.ts";
import {
  connect,
  decodeHello,
  decodeReadiness,
  fixtureDriver,
  isActionResult,
  NOT_SECURE,
  png,
  SHOT,
  X11,
} from "./LinuxComputerUseHelper.testkit.ts";
import { makeSignalMonitor } from "./linuxSignals.ts";
import {
  detectLinuxSession,
  linuxCapabilities,
  linuxReadiness,
  linuxSessionFacts,
  pngColors,
  type ReadinessFacts,
} from "./linuxSession.ts";
import { readLinuxReadiness } from "./readiness.ts";
import { CROPPED_CAPTURE } from "./windowCapture.ts";
import { STILL_DRAWING, UNREDIRECTED_CAPTURE, type DriverShot } from "./x11WindowCapture.ts";

describe("Linux session facts", () => {
  it("refuses Wayland GNOME 50 for readiness as the helper does, without probing the driver", async () => {
    let versionReads = 0;
    const gnomeShellVersion = () => {
      versionReads++;
      return "GNOME Shell 50.1\n";
    };
    const facts = linuxSessionFacts(
      {
        WAYLAND_DISPLAY: "wayland-0",
        XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      gnomeShellVersion,
    );
    const calls: string[] = [];
    const readiness = await readLinuxReadiness(
      {
        session: detectLinuxSession(facts),
        uinputWritable: async () => true,
        secureFocus: async () => NOT_SECURE,
        capture: { route: "driver" },
        call: async (tool) => {
          calls.push(tool);
          return "unexpected";
        },
      },
      15_000,
    );
    expect(facts.gnomeShellMajor).toBe(50);
    // Refused for GNOME 50 itself, not for a missing session bus or display.
    expect(detectLinuxSession(facts).unsupported).toMatch(/^GNOME 50 on Wayland/);
    expect(computerUseReady(readiness)).toBe(false);
    expect(calls).toEqual([]);
    // Only Wayland GNOME reads the version; X11 never runs gnome-shell.
    linuxSessionFacts({ DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, gnomeShellVersion);
    expect(versionReads).toBe(1);
  });
});

describe("Linux readiness grants (#1392)", () => {
  const session = detectLinuxSession(
    linuxSessionFacts({ DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" }, () => ""),
  );
  const facts = (overrides: Partial<ReadinessFacts>): ReadinessFacts => ({
    session,
    driver: { x11: true, wayland: false, atspi: true },
    capture: "varied",
    tree: "ready",
    uinputWritable: false,
    captureRefused: undefined,
    listingRefused: false,
    ...overrides,
  });

  it("AT-SPI is granted only after a real read answered, never while it does not answer", () => {
    const silent = linuxReadiness(
      facts({ driver: { x11: true, wayland: false, atspi: false }, tree: "unavailable" }),
    );
    expect(silent.grants.accessibility).toBe("unknown");
    expect(silent.reasons.join(" ")).toMatch(/AT-SPI does not answer/);
    // AT-SPI is up, but no window has been read through it yet.
    const unread = linuxReadiness(facts({ capture: "noWindow", tree: "unavailable" }));
    expect(unread.grants.accessibility).toBe("unknown");
    expect(unread.reasons.join(" ")).toMatch(/No window is open to read app controls/);
    expect(linuxReadiness(facts({})).grants.accessibility).toBe("granted");
    expect(linuxReadiness(facts({ tree: "empty" })).grants.accessibility).toBe("granted");
  });
});

describe("Linux computer use helper conformance", () => {
  it("hello binds the helper and names every protocol method as supported or unsupported", async () => {
    const helper = await connect();
    const hello = decodeHello(helper.hello);
    if (!("capabilities" in hello)) throw new Error("refused");
    expect(hello.binding).toEqual({
      executable: "/opt/goat/goat-computer-use",
      pid: 77,
      generation: "g1",
    });
    expect(Object.keys(hello.capabilities.methods).toSorted()).toEqual(
      [...COMPUTER_USE_METHODS].toSorted(),
    );
    // watch and unwatch are served, and the signals they arm are named (#1235); the stopgap
    // that marked them unsupported (#1294) is replaced by the real implementation.
    expect(hello.capabilities).toMatchObject({
      platform: "linux",
      backgroundDelivery: true,
      methods: { watch: "supported", unwatch: "supported" },
      signals: { privateMode: "supported", humanInput: "supported" },
    });
    await helper.close();
  });

  it("a client on another protocol version is refused before any work", async () => {
    const helper = await connect({ clientApiVersion: COMPUTER_USE_PROTOCOL_VERSION + 1 });
    expect(helper.hello).toMatchObject({ outcome: "refused", reason: "incompatibleClientVersion" });
    expect(helper.driver.state.sent).toEqual([]);
  });

  it("a hello larger than the frame limit is refused as it streams in", async () => {
    const helper = await connect({ maxFrameBytes: 64 * 1024, helloPadding: 65 * 1024 });
    expect(helper.hello).toMatchObject({ outcome: "refused", reason: "frameTooLarge" });
  });

  it("observe, act, observe: a change elsewhere in the window is shown but does not confirm the click", async () => {
    const helper = await connect();
    const first = await helper.observe();
    expect(first.observation).toMatchObject({ kind: "full", reason: "first", privateMode: false });
    expect(first.image).toEqual({ mimeType: "image/png", data: SHOT });
    expect(first.observation.screenshot).toEqual({ mimeType: "image/png", width: 42, height: 32 });
    expect(JSON.stringify(first.result)).not.toContain(SHOT);
    // A password field's value never leaves, focused or not.
    expect(JSON.stringify(first.result)).not.toContain("hunter2");

    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    // The counter changed, not the button that was clicked: an app can change on its own.
    expect(result).toMatchObject({
      outcome: "unverifiable",
      dispatch: "dispatched_unknown",
      delivery: "background",
    });
    if (result.outcome === "refused" || result.observation?.kind !== "diff")
      throw new Error("no diff");
    expect(result.observation.changed).toEqual([
      expect.objectContaining({ ref: helper.ref(first.observation, "Count"), value: "1" }),
    ]);

    const again = await helper.observe({ since: result.observation.observationId });
    expect(again.observation).toMatchObject({ kind: "diff", added: [], changed: [], removed: [] });
    await helper.close();
  });

  it("a change to the element the action named confirms it, and no change at all is suspected_noop", async () => {
    const helper = await connect();
    helper.driver.state.setValueEffect = "unverifiable";
    const first = await helper.observe();
    const set = await helper.act(
      { action: "setValue", element: helper.ref(first.observation, "Name"), value: "hello" },
      first.observation,
    );
    expect(set).toMatchObject({ outcome: "confirmed", dispatch: "verified" });
    if (set.outcome === "refused" || !set.observation) throw new Error("no observation");
    const noop = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Name") } },
      set.observation,
    );
    expect(noop).toMatchObject({ outcome: "suspected_noop", dispatch: "verified" });
    await helper.close();
  });

  it("an image its bytes do not describe is not declared, so points into it are refused", async () => {
    const helper = await connect();
    helper.driver.state.imageData = "UE5H";
    const first = await helper.observe();
    expect(first.observation).not.toHaveProperty("screenshot");
    expect(first.image).toBeUndefined();
    expect(
      await helper.act({ action: "click", at: { x: 20, y: 60 } }, first.observation),
    ).toMatchObject({ outcome: "refused", reason: "staleElement" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("a ref from an older observation is staleElement and sends nothing", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const second = await helper.observe({ since: first.observation.observationId });
    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      { ...second.observation, observationId: first.observation.observationId },
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "staleElement" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("a window that leaves the screen starts a new epoch, and acting on the old one is refused", async () => {
    const helper = await connect();
    const first = await helper.observe();
    helper.driver.state.onScreen = false;
    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "epochChanged" });
    expect(helper.driver.state.sent).toEqual([]);
    const after = await helper.observe({ since: first.observation.observationId });
    expect(after.observation).toMatchObject({ kind: "full", reason: "unknown_since" });
    expect(after.observation.target.epoch).not.toBe(first.observation.target.epoch);
    await helper.close();
  });

  it("a focused password field pauses everything: the contract's private shape, actions refused", async () => {
    const helper = await connect({ focus: { known: true, secure: true, windows: 1 } });
    const seen = await helper.observe();
    expect(seen.observation).toMatchObject({
      privateMode: true,
      kind: "full",
      complete: false,
      elements: [],
    });
    expect(seen.observation).not.toHaveProperty("focused");
    expect(seen.observation).not.toHaveProperty("screenshot");
    expect(seen.image).toBeUndefined();
    const result = await helper.act({ action: "pressKey", key: "a" }, seen.observation);
    expect(result).toMatchObject({ outcome: "refused", reason: "privateMode" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("when AT-SPI cannot say what has focus it fails closed, even for a read that shows no password field", async () => {
    const helper = await connect({ focus: { known: false, secure: false, windows: 0 } });
    const seen = await helper.observe({ query: "Count" });
    expect(seen.observation).toMatchObject({ privateMode: true, elements: [] });
    expect(seen.image).toBeUndefined();
    await helper.close();
  });

  it("acting on a password field itself is refused even when it lacks focus", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const password = (first.observation.kind === "full" ? first.observation.elements : []).find(
      (element) => element.role === "password text",
    );
    const result = await helper.act(
      { action: "setValue", element: password?.ref ?? "", value: "x" },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "privateMode" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("background keys the driver cannot deliver are a backgroundUnavailable refusal, never sent input", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const result = await helper.act(
      { action: "pressKey", key: "arrowUp", modifiers: ["control", "option"] },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "backgroundUnavailable" });
    expect(isActionResult(result)).toBe(true);
    await helper.close();
  });

  it("a printable key outside the BMP reaches the driver as one key", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const result = await helper.act({ action: "pressKey", key: "😀" }, first.observation);
    // The fixture driver has no keyboard device, so the key is refused after reaching it.
    expect(result).toMatchObject({ outcome: "refused", reason: "backgroundUnavailable" });
    expect(helper.driver.state.sent).toEqual(["press_key"]);
    await helper.close();
  });

  it("keys Linux has no name for and actions the driver cannot name are typed unsupported", async () => {
    const helper = await connect();
    const first = await helper.observe();
    expect(await helper.act({ action: "pressKey", key: "f20" }, first.observation)).toMatchObject({
      outcome: "refused",
      reason: "unsupported",
      method: "pressKey",
      platform: "linux",
    });
    expect(
      await helper.act(
        {
          action: "performAction",
          element: helper.ref(first.observation, "Increment"),
          name: "menu.popup",
        },
        first.observation,
      ),
    ).toMatchObject({ outcome: "refused", reason: "unsupported", method: "performAction" });
    expect(
      await helper.act(
        {
          action: "setValue",
          element: helper.ref(first.observation, "Name"),
          value: "x",
          append: true,
        },
        first.observation,
      ),
    ).toMatchObject({ outcome: "refused", reason: "unsupported" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("a driver that exits after the action was sent makes it unverifiable, never a refusal", async () => {
    const helper = await connect();
    const first = await helper.observe();
    helper.driver.state.loseNext = true;
    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "unverifiable", dispatch: "dispatched_unknown" });
    expect(helper.driver.state.sent).toEqual(["click"]);
    await helper.close();
  });

  it("an action held inside the helper when it shuts down sends nothing and starts no driver", async () => {
    const helper = await connect();
    const first = await helper.observe();
    helper.gate.armed = true;
    const frameId = helper.send(
      "click",
      helper.actionParams(
        { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
        first.observation,
      ),
    );
    await helper.gate.entered.promise;
    await helper.end();
    helper.gate.release.resolve();
    expect((await helper.answer(frameId)).result).toMatchObject({
      outcome: "refused",
      reason: "helperUnavailable",
    });
    expect(helper.driver.state.sent).toEqual([]);
    expect(helper.starts()).toBe(1);
  });

  it("a request whose deadline passes while it waits in line is refused before anything is sent", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const params = helper.actionParams(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    helper.gate.armed = true;
    const held = helper.send("observe", { target: { pid: 10, windowId: 20 }, screenshot: false });
    await helper.gate.entered.promise;
    const late = helper.send("click", params, "g1", 5);
    helper.clock.now += 10;
    helper.gate.release.resolve();
    await helper.answer(held);
    expect((await helper.answer(late)).result).toMatchObject({
      outcome: "refused",
      reason: "busy",
    });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("an action whose answer outgrows the frame keeps its outcome and leaves the evidence out", async () => {
    const helper = await connect({ maxFrameBytes: 64 * 1024 });
    const first = await helper.observe();
    helper.driver.state.imageData = png(160, 160, "noise").toString("base64");
    const reply = await helper.request(
      "click",
      helper.actionParams(
        { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
        first.observation,
      ),
    );
    expect(reply.result).toMatchObject({ outcome: "unverifiable", dispatch: "dispatched_unknown" });
    expect(reply.result).not.toHaveProperty("observation");
    expect(reply.image).toBeUndefined();
    expect(helper.driver.state.sent).toEqual(["click"]);
    await helper.close();
  });

  it("a driver error that reports delivered input stays a sent action, whatever its code", async () => {
    const helper = await connect();
    const first = await helper.observe();
    helper.driver.state.nextAnswer = {
      isError: true,
      text: "Foreground delivery failed after the key was acknowledged.",
      structured: { code: "foreground_unavailable", delivered_count: 1 },
      images: [],
    };
    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "unverifiable", dispatch: "dispatched_unknown" });
    await helper.close();
  });

  it("an action validated before the driver exits never reaches the next driver", async () => {
    const helper = await connect();
    const first = await helper.observe();
    helper.gate.armed = true;
    // A key names no element, so only the driver generation stands between it and a new driver.
    const frameId = helper.send(
      "pressKey",
      helper.actionParams({ action: "pressKey", key: "a" }, first.observation),
    );
    await helper.gate.entered.promise;
    helper.driver.exit();
    await Promise.resolve();
    await Promise.resolve();
    helper.gate.release.resolve();
    expect((await helper.answer(frameId)).result).toMatchObject({
      outcome: "refused",
      reason: "helperUnavailable",
    });
    expect(helper.driver.state.sent).toEqual([]);
    expect(helper.starts()).toBe(1);
    await helper.close();
  });

  it("a right click on an element is real pointer input at its center, never an activation", async () => {
    const helper = await connect();
    const first = await helper.observe();
    await helper.act(
      { action: "rightClick", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(helper.driver.state.calls).toEqual([
      { tool: "click", args: expect.objectContaining({ x: 210, y: 71, button: "right" }) },
    ]);
    expect(helper.driver.state.calls[0]?.args).not.toHaveProperty("element_token");
    expect(helper.driver.state.count).toBe(0);
    await helper.close();
  });

  it("readiness does not let one window without accessibility or covered from view speak for the desktop", async () => {
    const helper = await connect();
    // Listed first: an app that never joined AT-SPI, whose covered window captures blank.
    helper.driver.state.otherWindows = [
      { pid: 30, window_id: 40, title: "Other", is_on_screen: true },
    ];
    helper.focusByPid.set(30, { known: false, secure: false, windows: 0 });
    helper.driver.state.readinessImages.set(30, png(8, 4, false).toString("base64"));
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness).toMatchObject({ capture: "ready", tree: "ready" });
    await helper.close();
  });

  it("a capture whose bytes cannot be read does not prove capture", async () => {
    const helper = await connect();
    helper.driver.state.readinessImage = "UE5H";
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness.capture).toBe("unavailable");
    expect(computerUseReady(readiness)).toBe(false);
    await helper.close();
  });

  it("the reply to the largest request the channel accepts still fits the frame", async () => {
    const helper = await connect({ maxFrameBytes: 64 * 1024 });
    const id = "i".repeat(64 * 1024 - 4096 - 200);
    helper.input.write(
      JSON.stringify({ id, generation: "g1", method: "observe", deadlineMs: 5_000, params: {} }) +
        "\n",
    );
    await helper.answer(id);
    expect(Math.max(...helper.sizes)).toBeLessThanOrEqual(64 * 1024);
    await helper.close();
  });

  it("without a desktop session every window method is a typed helperUnavailable refusal", async () => {
    const helper = await connect({ session: { ...X11, display: undefined } });
    for (const method of ["listWindows", "observe", "click"]) {
      const reply = await helper.request(method, {});
      expect(reply.result).toMatchObject({ outcome: "refused", reason: "helperUnavailable" });
    }
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness).toMatchObject({
      helper: "authenticated",
      capture: "unavailable",
      tree: "unavailable",
      input: "unavailable",
    });
    expect(readiness.platform).toBeUndefined();
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("GNOME 50 or later on Wayland is unsupported for every window method, with the reason", async () => {
    const helper = await connect({
      session: { ...X11, display: undefined, waylandDisplay: "wayland-0", gnomeShellMajor: 50 },
    });
    expect(helper.hello).toMatchObject({
      capabilities: {
        methods: { observe: "unsupported", click: "unsupported", capabilities: "supported" },
        backgroundDelivery: false,
      },
    });
    const reply = await helper.request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
    });
    expect(reply.result).toMatchObject({
      outcome: "refused",
      reason: "unsupported",
      method: "observe",
      platform: "linux",
    });
    expect(String(reply.result.message)).toContain("GNOME 50");
    await helper.close();
  });

  it("on Wayland without XWayland a background pixel click is refused before dispatch; element actions still run", async () => {
    const helper = await connect({
      session: { ...X11, display: undefined, waylandDisplay: "wayland-0", gnomeShellMajor: 46 },
    });
    const first = await helper.observe();
    expect(
      await helper.act({ action: "click", at: { x: 20, y: 60 } }, first.observation),
    ).toMatchObject({ outcome: "refused", reason: "backgroundUnavailable" });
    expect(helper.driver.state.sent).toEqual([]);
    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(result.outcome).not.toBe("refused");
    await helper.close();
  });

  it("on X11 the screenshot is the window's own capture, at the size the driver's points are in", async () => {
    const shots: DriverShot[] = [];
    const helper = await connect({
      capture: {
        route: "own",
        capture: async (_windowId, shot) => {
          shots.push(shot);
          return {
            png: png(shot.width, shot.height, false),
            rgb: new Uint8Array(shot.width * shot.height * 3),
            width: shot.width,
            height: shot.height,
          };
        },
      },
    });
    const first = await helper.observe();
    // The driver still took its screenshot, so its pointer scale is current; its image is not sent.
    expect(helper.driver.state.reads.at(-1)?.include_screenshot).toBe(true);
    expect(shots).toEqual([{ width: 420, height: 320, windowWidth: 420, windowHeight: 320 }]);
    expect(first.image?.data).not.toBe(SHOT);
    expect(first.image?.data).toBe(png(420, 320, false).toString("base64"));
    expect(first.observation.screenshot).toEqual({
      mimeType: "image/png",
      width: 420,
      height: 320,
    });
    const increment =
      first.observation.kind === "full"
        ? first.observation.elements.find((element) => element.label === "Increment")
        : undefined;
    expect(increment?.frame).toEqual({ x: 12, y: 54, width: 396, height: 34 });
    await helper.close();
  });

  it("a window whose own pixels cannot be proven gets no screenshot: observe and readiness say why", async () => {
    const helper = await connect({
      capture: { route: "own", capture: async () => ({ refused: UNREDIRECTED_CAPTURE }) },
    });
    const shot = await helper.request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
    });
    expect(shot.result).toMatchObject({ outcome: "refused", reason: "unsupported" });
    expect(shot.image).toBeUndefined();
    const controls = await helper.observe({ screenshot: false });
    expect(controls.observation.kind).toBe("full");
    expect(controls.image).toBeUndefined();
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness).toMatchObject({ capture: "unavailable", tree: "ready" });
    expect(readiness.reasons).toContain(UNREDIRECTED_CAPTURE);
    expect(computerUseReady(readiness)).toBe(false);
    await helper.close();
  });

  it("a capture that may succeed on the next read is refused as busy, so the agent observes again", async () => {
    const helper = await connect({
      capture: {
        route: "own",
        capture: async () => ({ refused: STILL_DRAWING, transient: true }),
      },
    });
    const shot = await helper.request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
    });
    expect(shot.result).toMatchObject({ outcome: "refused", reason: "busy" });
    expect(shot.image).toBeUndefined();
    await helper.close();
  });

  it("where the driver would crop the whole screen, nothing is captured and readiness says why", async () => {
    const helper = await connect({
      session: { ...X11, display: undefined, waylandDisplay: "wayland-0", gnomeShellMajor: 46 },
      capture: { route: "refused", reason: CROPPED_CAPTURE },
    });
    const shot = await helper.request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
    });
    expect(shot.result).toMatchObject({ outcome: "refused", reason: "unsupported" });
    expect(helper.driver.state.reads).toEqual([]);
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness).toMatchObject({
      grants: { screenCapture: "unknown" },
      capture: "unavailable",
    });
    expect(readiness.reasons).toContain(CROPPED_CAPTURE);
    await helper.close();
  });

  it("readiness proves the tree and a non-blank capture, and says input is foreground only without uinput", async () => {
    const helper = await connect();
    const readiness = decodeReadiness((await helper.request("permissions", {})).result);
    expect(readiness).toMatchObject({
      grants: { accessibility: "granted", screenCapture: "granted" },
      helper: "authenticated",
      capture: "ready",
      tree: "ready",
      input: "foregroundOnly",
      blockers: [],
      platform: { linux: { displayServer: "x11" } },
    });
    expect(readiness.reasons).toHaveLength(1);
    expect(computerUseReady(readiness)).toBe(true);
    await helper.close();
  });

  it("a frame from another helper generation or one that does not decode gets a typed refusal", async () => {
    const helper = await connect();
    expect((await helper.request("listWindows", {}, "g0")).result).toMatchObject({
      outcome: "refused",
      reason: "invalidRequest",
    });
    expect((await helper.request("observe", { target: { pid: "x" } })).result).toMatchObject({
      outcome: "refused",
      reason: "invalidRequest",
    });
    await helper.close();
  });
});

describe("makeLinuxHelper shutdown", () => {
  it("every close waits for the one driver shutdown, so a signal during EOF cleanup cannot exit early", async () => {
    const { client } = fixtureDriver();
    const closing = Promise.withResolvers<void>();
    const helper = makeLinuxHelper({
      session: detectLinuxSession(X11),
      screen: ":91",
      startDriver: async () => ({ ...client, close: () => closing.promise }),
      secureFocus: async () => NOT_SECURE,
      capture: { route: "driver" },
      uinputWritable: async () => false,
      settle: async () => undefined,
      newId: () => "o",
      now: () => 0,
      signals: makeSignalMonitor({
        secureFocus: async () => NOT_SECURE,
        windowOpen: async () => undefined,
        input: undefined,
        inputLost: () => undefined,
        delay: () => new Promise<void>(() => undefined),
        now: () => 0,
        every: () => () => undefined,
        afterReply: () => undefined,
        emit: () => undefined,
      }),
      capabilities: linuxCapabilities(detectLinuxSession(X11), false),
    });
    await helper.handle("listWindows", {}, 1_000);
    let done = 0;
    void helper.close().then(() => done++);
    void helper.close().then(() => done++);
    await Promise.resolve();
    expect(done).toBe(0);
    closing.resolve();
    await helper.close();
    expect(done).toBe(2);
  });
});

describe("pngColors", () => {
  it("tells a solid capture from one with content", () => {
    expect(pngColors(png(16, 8, false))).toBe("uniform");
    expect(pngColors(png(16, 8, true))).toBe("varied");
    expect(pngColors(Buffer.from("not a png"))).toBeUndefined();
  });
});

describe("Linux readiness on a Wayland desktop the driver cannot read (#1610)", () => {
  // Native GNOME Wayland: readiness's own listing answers, but the agent's listing passes the
  // driver's consent, which needs the screen layout get_screen_size cannot read there.
  const readinessWith = (screenSize: "fails" | "answers") =>
    readLinuxReadiness(
      {
        session: detectLinuxSession(
          linuxSessionFacts(
            {
              WAYLAND_DISPLAY: "wayland-0",
              XDG_CURRENT_DESKTOP: "GNOME",
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
            },
            () => "GNOME Shell 46.0\n",
          ),
        ),
        uinputWritable: async () => false,
        secureFocus: async () => NOT_SECURE,
        capture: { route: "refused", reason: CROPPED_CAPTURE },
        call: async (tool) => {
          const ok = (structured: unknown) => ({
            isError: false,
            text: "",
            structured,
            images: [],
          });
          if (tool === "check_permissions") return ok({ x11: false, wayland: true, atspi: true });
          if (tool === "list_windows") return ok({ windows: [{ pid: 30, window_id: 1 }] });
          if (tool === "get_screen_size")
            return screenSize === "answers"
              ? ok({ width: 1600, height: 1000, scale_factor: 1 })
              : { isError: true, text: "$DISPLAY variable not set", structured: null, images: [] };
          return "unexpected";
        },
      },
      15_000,
    );

  it("does not call app controls ready when the driver refuses to list windows for agents", async () => {
    const refused = await readinessWith("fails");
    expect(refused.tree).toBe("unavailable");
    expect(refused.reasons.join(" ")).toMatch(/cannot read this Wayland desktop's screen layout/);
    // AT-SPI itself answered: the grant stays true to what was read.
    expect(refused.grants.accessibility).toBe("granted");
    const answered = await readinessWith("answers");
    expect(answered.tree).toBe("ready");
  });
});
