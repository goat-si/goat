// @effect-diagnostics nodeBuiltinImport:off -- The helper's channel is a Node stream; the test feeds it one.
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseHelloReply,
  ComputerUseObservation,
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
  pngColors,
  type LinuxSessionFacts,
} from "./linuxSession.ts";

const decodeObservation = Schema.decodeUnknownSync(ComputerUseObservation);
const decodeResult = Schema.decodeUnknownSync(ComputerUseActionResult);
const decodeHello = Schema.decodeUnknownSync(ComputerUseHelloReply);
const isActionResult = Schema.is(ComputerUseActionResult);

const X11: LinuxSessionFacts = {
  display: ":91",
  waylandDisplay: undefined,
  sessionBus: "unix:path=/run/user/1000/bus",
  currentDesktop: "GNOME",
  gnomeShellMajor: 46,
};

/** A PNG of width x height, solid unless striped. */
function png(width: number, height: number, striped: boolean) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width; x++)
      raw[row * (width * 3 + 1) + 1 + x * 3] = striped && x % 2 === 0 ? 255 : 10;
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]);
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
  const state = { count: 0, name: "", snapshot: 0, onScreen: true, sent: [] as string[] };
  const ok = (structured: unknown, text = "", images: DriverToolResult["images"] = []) =>
    ({ isError: false, text, structured, images }) satisfies DriverToolResult;
  const refused = (code: string, text: string) =>
    ({ isError: true, text, structured: { code }, images: [] }) satisfies DriverToolResult;
  const tokenCurrent = (token: unknown) =>
    typeof token === "string" && token.startsWith("s" + state.snapshot + ":");
  const client: DriverClient = {
    pid: 4242,
    version: "0.37.0",
    exited: new Promise(() => undefined),
    close: async () => undefined,
    call: async (tool, args) => {
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
          return ok({}, "", [{ mimeType: "image/png", data: png(8, 4, true).toString("base64") }]);
        state.snapshot++;
        const token = (index: number) => "s" + state.snapshot + ":" + index;
        const shot = args.include_screenshot !== false;
        return ok(
          {
            pid: 10,
            window_id: 20,
            window_bounds: { width: 420, height: 320 },
            ...(shot
              ? { screenshot_width: 420, screenshot_height: 320, screenshot_mime_type: "image/png" }
              : {}),
            elements: [
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
            ],
          },
          "",
          shot ? [{ mimeType: "image/png", data: "UE5H" }] : [],
        );
      }
      state.sent.push(tool);
      if (tool === "click") {
        if (args.element_token === undefined)
          return refused("background_unavailable", "Background delivery is not available.");
        if (!tokenCurrent(args.element_token))
          return refused("stale_element_token", "element_token is stale");
        if (args.element_token === "s" + state.snapshot + ":1") state.count++;
        return ok({ effect: "unverifiable", route: "accessibility" }, "Clicked element [1].");
      }
      if (tool === "set_value") {
        state.name = String(args.value);
        return ok({ effect: "confirmed" }, "Set value; read back.");
      }
      if (tool === "press_key" || tool === "hotkey" || tool === "type_text")
        return refused(
          "background_unavailable",
          "Background keyboard delivery on X11 needs a virtual master keyboard fed by a uinput device.",
        );
      return refused("invalid_arguments", "unknown tool " + tool);
    },
  };
  return { state, client };
}

/** An action as the agent writes it; the helper fills in the target and observation. */
type ActionInput = ComputerUseActionRequest extends infer Request
  ? Request extends ComputerUseActionRequest
    ? Omit<Request, "target" | "observationId" | "delivery"> & {
        readonly delivery?: ComputerUseActionRequest["delivery"];
      }
    : never
  : never;

/** One helper behind its real channel, and a client that speaks the protocol to it. */
async function connect(
  options: {
    readonly session?: LinuxSessionFacts;
    readonly focus?: SecureFocus;
    readonly clientApiVersion?: number;
  } = {},
) {
  const session = detectLinuxSession(options.session ?? X11);
  const driver = fixtureDriver();
  const focus = { current: options.focus ?? { known: true, secure: false } };
  let id = 0;
  const helper = makeLinuxHelper({
    session,
    screen: ":91",
    startDriver: async () => driver.client,
    secureFocus: async () => focus.current,
    uinputWritable: async () => false,
    settle: async () => undefined,
    newId: () => "o" + ++id,
  });
  const input = new NodeStream.PassThrough();
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  const served = serveHelperChannel({
    input,
    write: (line) => {
      lines.push(line.trimEnd());
      waiters.splice(0).forEach((wake) => wake());
    },
    binding: { executable: "/opt/goat/goat-computer-use", pid: 77, generation: "g1" },
    capabilities: linuxCapabilities(session),
    maxFrameBytes: 1024 * 1024,
    helper,
  });
  const nextLine = async () => {
    while (lines.length === 0) await new Promise<void>((wake) => waiters.push(wake));
    return JSON.parse(lines.shift() ?? "") as Record<string, unknown>;
  };
  input.write(
    JSON.stringify({
      clientApiVersion: options.clientApiVersion ?? COMPUTER_USE_PROTOCOL_VERSION,
    }) + "\n",
  );
  const hello = await nextLine();
  let serial = 0;
  const request = async (method: string, params: unknown = {}, generation = "g1") => {
    const frameId = String(++serial);
    input.write(
      JSON.stringify({ id: frameId, generation, method, deadlineMs: 5_000, params }) + "\n",
    );
    const reply = await nextLine();
    expect(reply.id).toBe(frameId);
    return reply as { result: Record<string, unknown>; image?: { mimeType: string; data: string } };
  };
  const observe = async (since?: string) => {
    const reply = await request("observe", {
      target: { pid: 10, windowId: 20 },
      screenshot: true,
      ...(since ? { since } : {}),
    });
    return {
      ...reply,
      observation: decodeObservation(reply.result),
    };
  };
  const act = async (action: ActionInput, from: ComputerUseObservation) => {
    const reply = await request(action.action, {
      delivery: "background",
      ...action,
      target: from.target,
      observationId: from.observationId,
    });
    return decodeResult(reply.result);
  };
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
    request,
    observe,
    act,
    ref,
    driver,
    focus,
    close: async () => (input.end(), served),
  };
}

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

  it("a client on another protocol version is refused before any work", async () => {
    const helper = await connect({ clientApiVersion: COMPUTER_USE_PROTOCOL_VERSION + 1 });
    expect(helper.hello).toMatchObject({ outcome: "refused", reason: "incompatibleClientVersion" });
    expect(helper.driver.state.sent).toEqual([]);
  });

  it("observe, act, observe: a click is confirmed by the diff it caused and refs stay stable", async () => {
    const helper = await connect();
    const first = await helper.observe();
    expect(first.observation).toMatchObject({ kind: "full", reason: "first", privateMode: false });
    expect(first.image).toEqual({ mimeType: "image/png", data: "UE5H" });
    expect(JSON.stringify(first.result)).not.toContain("UE5H");
    // A password field's value never leaves, focused or not.
    expect(JSON.stringify(first.result)).not.toContain("hunter2");

    const result = await helper.act(
      { action: "click", at: { element: helper.ref(first.observation, "Increment") } },
      first.observation,
    );
    expect(result).toMatchObject({
      outcome: "confirmed",
      dispatch: "verified",
      delivery: "background",
    });
    if (result.outcome === "refused" || !result.observation) throw new Error("no observation");
    expect(result.observation).toMatchObject({
      kind: "diff",
      since: first.observation.observationId,
    });
    if (result.observation.kind !== "diff") throw new Error("not a diff");
    expect(result.observation.changed).toEqual([
      expect.objectContaining({ ref: helper.ref(first.observation, "Count"), value: "1" }),
    ]);

    const again = await helper.observe(result.observation.observationId);
    expect(again.observation).toMatchObject({ kind: "diff", added: [], changed: [], removed: [] });
    await helper.close();
  });

  it("a ref from an older observation is staleElement and sends nothing", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const second = await helper.observe(first.observation.observationId);
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
    const after = await helper.observe(first.observation.observationId);
    expect(after.observation).toMatchObject({ kind: "full", reason: "unknown_since" });
    expect(after.observation.target.epoch).not.toBe(first.observation.target.epoch);
    await helper.close();
  });

  it("a focused password field pauses everything: no tree, no screenshot, actions refused", async () => {
    const helper = await connect({ focus: { known: true, secure: true } });
    const seen = await helper.observe();
    expect(seen.observation).toMatchObject({ privateMode: true, kind: "full", elements: [] });
    expect(seen.image).toBeUndefined();
    const result = await helper.act({ action: "pressKey", key: "a" }, seen.observation);
    expect(result).toMatchObject({ outcome: "refused", reason: "privateMode" });
    expect(helper.driver.state.sent).toEqual([]);
    await helper.close();
  });

  it("when AT-SPI cannot say what has focus and a password field is present, it fails closed", async () => {
    const helper = await connect({ focus: { known: false, secure: false } });
    const seen = await helper.observe();
    expect(seen.observation.privateMode).toBe(true);
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

  it("setValue confirmed by the driver's read back carries the diff", async () => {
    const helper = await connect();
    const first = await helper.observe();
    const result = await helper.act(
      { action: "setValue", element: helper.ref(first.observation, "Name"), value: "hello" },
      first.observation,
    );
    expect(result).toMatchObject({ outcome: "confirmed", dispatch: "verified" });
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

  it("without a desktop session every window method is a typed helperUnavailable refusal", async () => {
    const helper = await connect({ session: { ...X11, display: undefined } });
    for (const method of ["listWindows", "observe", "click"]) {
      const reply = await helper.request(method, {});
      expect(reply.result).toMatchObject({ outcome: "refused", reason: "helperUnavailable" });
    }
    const permissions = await helper.request("permissions", {});
    expect(permissions.result).toMatchObject({
      accessibility: false,
      screenCapture: false,
      linux: { displayServer: "none" },
    });
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
    expect(result.outcome).toBe("confirmed");
    await helper.close();
  });

  it("readiness reports AT-SPI, a proven non-blank capture and foreground-only input without uinput", async () => {
    const helper = await connect();
    const reply = await helper.request("permissions", {});
    expect(reply.result).toMatchObject({
      accessibility: true,
      screenCapture: true,
      linux: {
        displayServer: "x11",
        accessibility: "ready",
        capture: "ready",
        input: "foregroundOnly",
      },
    });
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

describe("pngColors", () => {
  it("tells a solid capture from one with content", () => {
    expect(pngColors(png(16, 8, false))).toBe("uniform");
    expect(pngColors(png(16, 8, true))).toBe("varied");
    expect(pngColors(Buffer.from("not a png"))).toBeUndefined();
  });
});
