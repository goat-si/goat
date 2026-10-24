// @effect-diagnostics nodeBuiltinImport:off -- The helper's channel is a Node stream; the tests feed it one.
/**
 * A Linux helper behind its real channel, driven by a scripted Cua Driver that answers like the
 * pinned 0.37.0 driver does for the GOAT fixture window (fixtures/goat-cu-fixture.py).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseHelloReply,
  ComputerUseObservation,
  ComputerUseReadiness,
  type ComputerUseActionRequest,
  type ComputerUseWindowTarget,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { SecureFocus } from "./atspiFocus.ts";
import type { DriverClient, DriverToolResult } from "./CuaDriverMcp.ts";
import type { HumanInput } from "./humanInputSource.ts";
import { serveHelperChannel } from "./helperChannel.ts";
import { makeLinuxHelper } from "./LinuxComputerUseHelper.ts";
import { makeSignalMonitor } from "./linuxSignals.ts";
import { detectLinuxSession, linuxCapabilities, type LinuxSessionFacts } from "./linuxSession.ts";
import type { CaptureRoute } from "./windowCapture.ts";

const decodeObservation = Schema.decodeUnknownSync(ComputerUseObservation);
const decodeResult = Schema.decodeUnknownSync(ComputerUseActionResult);
export const decodeHello = Schema.decodeUnknownSync(ComputerUseHelloReply);
export const decodeReadiness = Schema.decodeUnknownSync(ComputerUseReadiness);
export const isActionResult = Schema.is(ComputerUseActionResult);

export const X11: LinuxSessionFacts = {
  display: ":91",
  waylandDisplay: undefined,
  sessionBus: "unix:path=/run/user/1000/bus",
  currentDesktop: "GNOME",
  gnomeShellMajor: 46,
};
export const SHOT = png(42, 32, true).toString("base64");
export const NOT_SECURE: SecureFocus = { known: true, secure: false, windows: 1 };

/** A PNG of width x height: solid, striped, or noise that does not compress. */
export function png(width: number, height: number, fill: boolean | "noise") {
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
export function fixtureDriver() {
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
    windowOpen: true,
    /** The next list_windows answers with an error and no list. */
    nextListError: false,
    /** Windows of other apps, listed before the fixture's own. */
    otherWindows: [] as Array<{
      pid: number;
      window_id: number;
      title: string;
      is_on_screen: boolean;
    }>,
    /** Readiness captures by pid, for windows that capture differently from the fixture's. */
    readinessImages: new Map<number, string>(),
    calls: [] as Array<{ tool: string; args: Readonly<Record<string, unknown>> }>,
    /** Answers the next input call instead of the fixture's own behavior. */
    nextAnswer: undefined as DriverToolResult | undefined,
    readinessImage: png(8, 4, true).toString("base64"),
    /** Every get_window_state the driver was asked for, as asked. */
    reads: [] as Array<Readonly<Record<string, unknown>>>,
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
    if (tool === "list_windows" && state.nextListError) {
      state.nextListError = false;
      return {
        isError: true,
        text: "AT-SPI timed out.",
        structured: { code: "timeout" },
        images: [],
      };
    }
    if (tool === "list_windows")
      return ok({
        windows: !state.windowOpen
          ? []
          : [
              ...state.otherWindows,
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
      state.reads.push(args);
      if (args.include_accessibility_tree === false)
        // The readiness images are 8 by 4.
        return ok(
          { screenshot_width: 8, screenshot_height: 4, window_bounds: { width: 420, height: 320 } },
          "",
          [
            {
              mimeType: "image/png",
              data: state.readinessImages.get(Number(args.pid)) ?? state.readinessImage,
            },
          ],
        );
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

type Reply = {
  id: string;
  result: Record<string, unknown>;
  image?: { mimeType: string; data: string };
};

/** One helper behind its real channel, and a client that speaks the protocol to it. */
export async function connect(
  options: {
    readonly session?: LinuxSessionFacts;
    readonly focus?: SecureFocus;
    readonly clientApiVersion?: number;
    readonly maxFrameBytes?: number;
    readonly helloPadding?: number;
    /** False: the helper cannot see a person's input devices on this desktop. */
    readonly personInput?: boolean;
    /** Where screenshots come from; the fixture driver's own capture unless a test says. */
    readonly capture?: CaptureRoute;
  } = {},
) {
  const session = detectLinuxSession(options.session ?? X11);
  const driver = fixtureDriver();
  const focus = { current: options.focus ?? NOT_SECURE };
  /** AT-SPI answers for other processes, where they differ from the fixture's. */
  const focusByPid = new Map<number, SecureFocus>();
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
  /** Every line the channel and the monitor wrote, in order. */
  const log: Array<Record<string, unknown>> = [];
  const tasks = new Set<() => Promise<void>>();
  // Work the monitor defers until a reply is written, and its completions.
  const afterReply: Array<() => Promise<void>> = [];
  const afterReplyDone: Array<Promise<void>> = [];
  /** What the person's devices report: the latest input, and whether the source broke. */
  const personInput: { latest: HumanInput | undefined; lost: boolean; lostCalls: number } = {
    latest: undefined,
    lost: false,
    lostCalls: 0,
  };
  const hasPersonInput = options.personInput ?? true;
  let windowOpen: (target: ComputerUseWindowTarget) => Promise<boolean | undefined> = async () =>
    undefined;
  let write: (line: string) => void = () => undefined;
  const signals = makeSignalMonitor({
    secureFocus: async () => focus.current,
    windowOpen: (target) => windowOpen(target),
    input: hasPersonInput
      ? {
          latest: () => personInput.latest,
          lost: () => personInput.lost,
          close: () => undefined,
        }
      : undefined,
    now: () => clock.now,
    every: (_ms, task) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
    afterReply: (task) => void afterReply.push(task),
    emit: (watchId, event) => write(JSON.stringify({ generation: "g1", watchId, event }) + "\n"),
    inputLost: () => void personInput.lostCalls++,
    // Focus probes in this fixture answer at once; the limit never comes into play.
    delay: () => new Promise<void>(() => undefined),
  });
  const capabilities = linuxCapabilities(session, hasPersonInput);
  const helper = makeLinuxHelper({
    session,
    screen: ":91",
    capture: options.capture ?? { route: "driver" },
    startDriver: async () => {
      starts++;
      return driver.client;
    },
    secureFocus: async (pid) => {
      if (gate.armed) {
        gate.armed = false;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return focusByPid.get(pid) ?? focus.current;
    },
    uinputWritable: async () => false,
    settle: async () => undefined,
    newId: () => "o" + ++id,
    now: () => clock.now,
    signals,
    capabilities,
  });
  windowOpen = helper.windowOpen;
  const input = new NodeStream.PassThrough();
  const ended = new Promise<void>((resolve) => input.once("end", () => resolve()));
  const replies = new Map<string, Reply>();
  const sizes: number[] = [];
  const lines: Array<Record<string, unknown>> = [];
  let wake: () => void = () => undefined;
  write = (line) => {
    sizes.push(Buffer.byteLength(line));
    const value = JSON.parse(line) as Record<string, unknown>;
    log.push(value);
    if (typeof value.id === "string") {
      replies.set(value.id, value as Reply);
      for (const task of afterReply.splice(0)) afterReplyDone.push(task());
    } else if (!("event" in value)) lines.push(value);
    wake();
  };
  const served = serveHelperChannel({
    input,
    write: (line) => write(line),
    binding: { executable: "/opt/goat/goat-computer-use", pid: 77, generation: "g1" },
    capabilities,
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
    focusByPid,
    log,
    personInput,
    /** Runs every armed signal check once, as its timer would. */
    tick: async () => {
      for (const task of Array.from(tasks)) await task();
    },
    armed: () => tasks.size,
    /** Events written so far, after the reply settles any afterReply work. */
    events: async () => {
      await Promise.all(afterReplyDone);
      return log.filter((entry) => "event" in entry);
    },
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
