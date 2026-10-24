// @effect-diagnostics nodeBuiltinImport:off -- The helper's channel is a Node stream; the test feeds it one.
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseHelloReply,
  ComputerUseObservation,
  ComputerUseReadiness,
  computerUseReady,
  type ComputerUseActionRequest,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { SecureFocus } from "./atspiFocus.ts";
import type { DriverClient, DriverToolResult } from "./CuaDriverMcp.ts";
import { serveHelperChannel } from "./helperChannel.ts";
import { makeLinuxHelper } from "./LinuxComputerUseHelper.ts";
import {
  detectLinuxSession,
  linuxCapabilities,
  linuxSessionFacts,
  pngColors,
  type LinuxSessionFacts,
} from "./linuxSession.ts";
import { readLinuxReadiness } from "./readiness.ts";

const decodeObservation = Schema.decodeUnknownSync(ComputerUseObservation);
const decodeResult = Schema.decodeUnknownSync(ComputerUseActionResult);
const decodeHello = Schema.decodeUnknownSync(ComputerUseHelloReply);
const decodeReadiness = Schema.decodeUnknownSync(ComputerUseReadiness);
const isActionResult = Schema.is(ComputerUseActionResult);

const X11: LinuxSessionFacts = {
  display: ":91",
  waylandDisplay: undefined,
  sessionBus: "unix:path=/run/user/1000/bus",
  currentDesktop: "GNOME",
  gnomeShellMajor: 46,
};
const SHOT = png(42, 32, true).toString("base64");
const NOT_SECURE: SecureFocus = { known: true, secure: false, windows: 1 };

/** A PNG of width x height: solid, striped, or noise that does not compress. */
function png(width: number, height: number, fill: boolean | "noise") {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  // Noise from a CSPRNG does not compress, so the PNG is about as large as its pixels.
  const noise = fill === "noise" ? NodeCrypto.randomBytes(raw.length) : undefined;
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width * 3; x++)
      raw[row * (width * 3 + 1) + 1 + x] = noise
        ? (noise[row * width * 3 + x] ?? 0)
        : fill && x % 6 === 0
          ? 255
          : 10;
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(NodeZlib.crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([length, Buffer.from(type), body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The GOAT fixture window (fixtures/goat-cu-fixture.py) as Cua Driver 0.37.0 answers for it on
 * X11 under Xvfb: AT-SPI clicks and value writes land, keys need a uinput device it lacks.
 */
function fixtureDriver() {
  const state = {
    count: 0,
    name: "",
    snapshot: 0,
    onScreen: true,
    sent: [] as string[],
    // The driver says 420x320; the bytes are what the agent sees.
    imageData: SHOT,
    setValueEffect: "confirmed",
    loseNext: false,
    calls: [] as Array<{ tool: string; args: Readonly<Record<string, unknown>> }>,
    /** Answers the next input call instead of the fixture's own behavior. */
    nextAnswer: undefined as DriverToolResult | undefined,
    readinessImage: png(8, 4, true).toString("base64"),
  };
  const exit = Promise.withResolvers<void>();
  const ok = (structured: unknown, text = "", images: DriverToolResult["images"] = []) =>
    ({ isError: false, text, structured, images }) satisfies DriverToolResult;
  const refused = (code: string, text: string) =>
    ({ isError: true, text, structured: { code }, images: [] }) satisfies DriverToolResult;
  const tokenCurrent = (token: unknown) =>
    typeof token === "string" && token.startsWith("s" + state.snapshot + ":");
  const call: DriverClient["call"] = async (tool, args) => {
    if (tool === "check_permissions") return ok({ x11: true, wayland: false, atspi: true });
    if (tool === "list_windows")
      return ok({
        windows: [
          {
            pid: 10,
            window_id: 20,
            title: "GOAT CU Fixture",
            app_name: "fixture.py",
            is_on_screen: state.onScreen,
          },
        ],
      });
    if (tool === "get_window_state") {
      if (args.include_accessibility_tree === false)
        return ok({}, "", [{ mimeType: "image/png", data: state.readinessImage }]);
      state.snapshot++;
      const token = (index: number) => "s" + state.snapshot + ":" + index;
      const shot = args.include_screenshot !== false;
      const elements = [
        {
          element_index: 0,
          element_token: token(0),
          role: "text",
          label: "Count",
          value: String(state.count),
          actions: ["activate"],
        },
        {
          element_index: 1,
          element_token: token(1),
          role: "push button",
          label: "Increment",
          actions: ["click"],
          screenshot_frame: { x: 12, y: 54, w: 396, h: 34 },
        },
        {
          element_index: 2,
          element_token: token(2),
          role: "text",
          label: "Name",
          value: state.name,
          actions: ["activate"],
        },
        {
          element_index: 3,
          element_token: token(3),
          role: "password text",
          label: "Password",
          value: "hunter2",
          actions: ["activate"],
        },
      ].filter((element) => typeof args.query !== "string" || element.label.includes(args.query));
      return ok(
        {
          pid: 10,
          window_id: 20,
          window_bounds: { width: 420, height: 320 },
          ...(shot
            ? { screenshot_width: 420, screenshot_height: 320, screenshot_mime_type: "image/png" }
            : {}),
          elements,
        },
        "",
        shot ? [{ mimeType: "image/png", data: state.imageData }] : [],
      );
    }
    state.sent.push(tool);
    state.calls.push({ tool, args });
    if (state.loseNext) return "lost";
    if (state.nextAnswer) {
      const answer = state.nextAnswer;
      state.nextAnswer = undefined;
      return answer;
    }
    if (tool === "click") {
      if (args.element_token === undefined)
        return refused("background_unavailable", "Background delivery is not available.");
      if (!tokenCurrent(args.element_token))
        return refused("stale_element_token", "element_token is stale");
      if (args.element_token === "s" + state.snapshot + ":1") state.count++;
      return ok({ effect: "unverifiable", route: "accessibility" }, "Clicked element.");
    }
    if (tool === "set_value") {
      state.name = String(args.value);
      return ok({ effect: state.setValueEffect }, "Set value.");
    }
    if (tool === "press_key" || tool === "hotkey" || tool === "type_text")
      return refused(
        "background_unavailable",
        "Background keyboard delivery on X11 needs a uinput device.",
      );
    return refused("invalid_arguments", "unknown tool " + tool);
  };
  const client: DriverClient = {
    pid: 4242,
    version: "0.37.0",
    exited: exit.promise,
    close: async () => undefined,
    call,
  };
  return { state, client, exit: () => exit.resolve() };
}

/** An action as the agent writes it; the helper test fills in the target and observation. */
type ActionInput = ComputerUseActionRequest extends infer Request
  ? Request extends ComputerUseActionRequest
    ? Omit<Request, "target" | "observationId" | "delivery"> & {
        readonly delivery?: ComputerUseActionRequest["delivery"];
      }
    : never
  : never;

type Reply = { result: Record<string, unknown>; image?: { mimeType: string; data: string } };

/** One helper behind its real channel, and a client that speaks the protocol to it. */
async function connect(
  options: {
    readonly session?: LinuxSessionFacts;
    readonly focus?: SecureFocus;
    readonly clientApiVersion?: number;
    readonly maxFrameBytes?: number;
    readonly helloPadding?: number;
  } = {},
) {
  const session = detectLinuxSession(options.session ?? X11);
  const driver = fixtureDriver();
  const focus = { current: options.focus ?? NOT_SECURE };
  const clock = { now: 0 };
  // Armed, the next focus check waits until released, so a test can act while a request is
  // held inside the helper.
  const gate = {
    armed: false,
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  let starts = 0;
  let id = 0;
  const helper = makeLinuxHelper({
    session,
    screen: ":91",
    startDriver: async () => {
      starts++;
      return driver.client;
    },
    secureFocus: async () => {
      if (gate.armed) {
        gate.armed = false;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return focus.current;
    },
    uinputWritable: async () => false,
    settle: async () => undefined,
    newId: () => "o" + ++id,
    now: () => clock.now,
  });
  const input = new NodeStream.PassThrough();
  const ended = new Promise<void>((resolve) => input.once("end", () => resolve()));
  const replies = new Map<string, Reply>();
  const sizes: number[] = [];
  const lines: Array<Record<string, unknown>> = [];
  let wake: () => void = () => undefined;
  const served = serveHelperChannel({
    input,
    write: (line) => {
      sizes.push(Buffer.byteLength(line));
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === "string") replies.set(value.id, value as Reply);
      else lines.push(value);
      wake();
    },
    binding: { executable: "/opt/goat/goat-computer-use", pid: 77, generation: "g1" },
    capabilities: linuxCapabilities(session),
    maxFrameBytes: options.maxFrameBytes ?? 1024 * 1024,
    helper,
  });
  const until = async <T>(read: () => T | undefined): Promise<T> => {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  input.write(
    JSON.stringify({
      clientApiVersion: options.clientApiVersion ?? COMPUTER_USE_PROTOCOL_VERSION,
      ...(options.helloPadding ? { padding: "x".repeat(options.helloPadding) } : {}),
    }) + "\n",
  );
  const hello = await until(() => lines.shift());
  let serial = 0;
  const send = (method: string, params: unknown = {}, generation = "g1", deadlineMs = 5_000) => {
    const frameId = String(++serial);
    input.write(JSON.stringify({ id: frameId, generation, method, deadlineMs, params }) + "\n");
    return frameId;
  };
  const answer = (frameId: string) => until(() => replies.get(frameId));
  const request = (method: string, params: unknown = {}, generation = "g1") =>
    answer(send(method, params, generation));
  const observe = async (extra: Record<string, unknown> = {}) => {
    const reply = await request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
      ...extra,
    });
    return { ...reply, observation: decodeObservation(reply.result) };
  };
  const actionParams = (action: ActionInput, from: ComputerUseObservation) => ({
    delivery: "background",
    ...action,
    target: from.target,
    observationId: from.observationId,
  });
  const act = async (action: ActionInput, from: ComputerUseObservation) =>
    decodeResult((await request(action.action, actionParams(action, from))).result);
  const ref = (observation: ComputerUseObservation, label: string) => {
    const elements =
      observation.kind === "full"
        ? observation.elements
        : [...observation.added, ...observation.changed];
    const found = elements.find((element) => element.label === label);
    if (!found) throw new Error("no element " + label);
    return found.ref;
  };
  return {
    hello,
    send,
    answer,
    request,
    observe,
    act,
    actionParams,
    ref,
    driver,
    focus,
    clock,
    gate,
    starts: () => starts,
    sizes,
    input,
    /** Ends stdin and waits until the channel has seen it, as a launcher closing the pipe. */
    end: () => {
      input.end();
      return ended;
    },
    close: async () => (input.end(), served),
  };
}

describe("Linux session facts", () => {
  it("refuses Wayland GNOME 50 for readiness as the helper does, without probing the driver", async () => {
    let versionReads = 0;
    const gnomeShellVersion = () => {
      versionReads++;
      return "GNOME Shell 50.1\n";
    };
    const facts = linuxSessionFacts(
      { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
      gnomeShellVersion,
    );
    const calls: string[] = [];
    const readiness = await readLinuxReadiness(
      {
        session: detectLinuxSession(facts),
        uinputWritable: async () => true,
        secureFocus: async () => NOT_SECURE,
        call: async (tool) => {
          calls.push(tool);
          return "unexpected";
        },
      },
      15_000,
    );
    expect(facts.gnomeShellMajor).toBe(50);
    expect(computerUseReady(readiness)).toBe(false);
    expect(calls).toEqual([]);
    // Only Wayland GNOME reads the version; X11 never runs gnome-shell.
    linuxSessionFacts({ DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, gnomeShellVersion);
    expect(versionReads).toBe(1);
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
    expect(hello.capabilities).toMatchObject({ platform: "linux", backgroundDelivery: true });
    await helper.close();
  });

  it("says it raises no safety signals yet, and refuses watch as typed unsupported", async () => {
    const helper = await connect();
    expect(helper.hello).toMatchObject({
      capabilities: {
        signals: { privateMode: "unsupported", humanInput: "unsupported" },
        methods: { watch: "unsupported", unwatch: "unsupported" },
      },
    });
    const reply = await helper.request("watch", {
      watchId: "w1",
      targets: [{ pid: 10, windowId: 20 }],
    });
    expect(reply.result).toMatchObject({
      outcome: "refused",
      reason: "unsupported",
      method: "watch",
      platform: "linux",
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
      uinputWritable: async () => false,
      settle: async () => undefined,
      newId: () => "o",
      now: () => 0,
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
