import {
  ComputerUseActionRequest,
  ComputerUseObserveRequest,
  computerUseDeadlineResult,
  computerUseImageInfo,
  type ComputerUseElement,
  type ComputerUseObservation,
  type ComputerUseRefusal,
  type ComputerUseRefusalReason,
  type ComputerUseWindow,
  COMPUTER_USE_ACTIONS,
  type ComputerUseMethod,
  unsupportedComputerUseMethod,
} from "@goat/contracts";
import {
  DriverWindowState,
  makeObservationTracker,
  type ObservationTracker,
} from "@goat/shared/computerUseObservation";
import * as Schema from "effect/Schema";

import { readLinuxReadiness } from "./readiness.ts";
import type { SecureFocus } from "./atspiFocus.ts";
import type { DriverClient, DriverImage, DriverToolResult } from "./CuaDriverMcp.ts";
import { driverRefusalCode, linuxActionResult, linuxDriverCall } from "./linuxActions.ts";
import { linuxCapabilities, type LinuxSession } from "./linuxSession.ts";

/**
 * What the Linux helper does with each protocol request (WS10 #1138). It owns one Cua Driver
 * child, started on first use and again after it dies; every window the driver knew is then
 * forgotten, since its tokens died with it. Requests run one at a time, so an action and the
 * read that confirms it never interleave with another request.
 */

export interface LinuxHelperDependencies {
  readonly session: LinuxSession;
  /** Names the screen in every epoch: DISPLAY or WAYLAND_DISPLAY. */
  readonly screen: string;
  readonly startDriver: () => Promise<DriverClient>;
  readonly secureFocus: (pid: number) => Promise<SecureFocus>;
  readonly uinputWritable: () => Promise<boolean>;
  /** Waits for an action's effect to reach the accessibility tree before it is read back. */
  readonly settle: () => Promise<void>;
  readonly newId: () => string;
  readonly now: () => number;
}

export interface HelperAnswer {
  readonly result: unknown;
  /** The screenshot an observation describes; it travels beside the result, never in it. */
  readonly image?: DriverImage;
}

export interface LinuxHelper {
  readonly handle: (
    method: ComputerUseMethod,
    params: unknown,
    deadlineMs: number,
  ) => Promise<HelperAnswer>;
  /** Ends the driver; its runtime, input devices and held keys go with it. */
  readonly close: () => Promise<void>;
}

const SECURE_ROLE = "password text";
const ACTIONS: ReadonlySet<string> = new Set(COMPUTER_USE_ACTIONS);

const refusal = (reason: ComputerUseRefusalReason, message: string): ComputerUseRefusal => ({
  outcome: "refused",
  reason,
  message,
});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const decodeObserve = Schema.decodeUnknownOption(ComputerUseObserveRequest);
const decodeAction = Schema.decodeUnknownOption(ComputerUseActionRequest);
const decodeRead = Schema.decodeUnknownOption(DriverWindowState);

interface DriverWindow {
  readonly pid: number;
  readonly window_id: number;
  readonly title?: string;
  readonly app_name?: string;
  readonly is_on_screen?: boolean;
}

/** How a window was last read, so the read after an action is the same kind of read. */
interface LastRead {
  readonly observationId: string;
  readonly screenshot: boolean;
  readonly query: string | undefined;
  readonly maxElements: number | undefined;
  readonly elements: Map<string, ComputerUseElement>;
}

export function makeLinuxHelper(deps: LinuxHelperDependencies): LinuxHelper {
  let driver: Promise<DriverClient> | undefined;
  let driverGeneration = 0;
  let observations: ObservationTracker = makeObservationTracker(deps.newId);
  const lastReads = new Map<string, LastRead>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;

  const ensureDriver = () => {
    if (closed) return Promise.reject(new Error("The helper is shutting down."));
    if (!driver) {
      const generation = ++driverGeneration;
      driver = deps.startDriver();
      void driver.then(
        (client) =>
          client.exited.then(() => {
            // Tokens die with the driver: a new generation at once, so an action validated
            // against this one cannot reach the next driver, and a clean start next time.
            if (driverGeneration !== generation) return;
            driverGeneration++;
            driver = undefined;
            observations = makeObservationTracker(deps.newId);
            lastReads.clear();
          }),
        () => {
          if (driverGeneration === generation) driver = undefined;
        },
      );
    }
    return driver;
  };

  const call = async (
    tool: string,
    args: Readonly<Record<string, unknown>>,
    deadlineMs: number,
    /** The driver generation the request was validated against; input goes to no other. */
    validated?: number,
  ): Promise<DriverToolResult | "deadline" | "lost" | ComputerUseRefusal> => {
    let client: DriverClient;
    try {
      client = await ensureDriver();
    } catch (error) {
      return refusal(
        "helperUnavailable",
        error instanceof Error ? error.message : "Cua Driver did not start.",
      );
    }
    if (validated !== undefined && validated !== driverGeneration)
      return refusal("helperUnavailable", "Cua Driver restarted; nothing was sent. Observe again.");
    const answer = await client.call(tool, args, deadlineMs);
    return answer === "unsent"
      ? refusal("helperUnavailable", "Cua Driver exited; nothing was sent. Try again.")
      : answer;
  };
  const isRefusal = (value: unknown): value is ComputerUseRefusal =>
    field(value, "outcome") === "refused";

  const windows = async (
    deadlineMs: number,
  ): Promise<ReadonlyArray<DriverWindow> | ComputerUseRefusal> => {
    const answer = await call("list_windows", {}, deadlineMs);
    if (answer === "deadline") return refusal("busy", "Listing windows took too long.");
    if (answer === "lost") return refusal("helperUnavailable", "Cua Driver exited.");
    if (isRefusal(answer)) return answer;
    const list = field(answer.structured, "windows");
    return Array.isArray(list) ? (list as DriverWindow[]) : [];
  };

  /** The window as it is now, with the epoch every ref and point is read against. */
  const locate = async (pid: number, windowId: number, deadlineMs: number) => {
    const list = await windows(deadlineMs);
    if (isRefusal(list)) return list;
    const window = list.find((entry) => entry.window_id === windowId);
    if (!window) {
      observations.forget(pid, windowId);
      lastReads.delete(pid + ":" + windowId);
      return refusal("windowNotFound", "Window " + windowId + " is not open. List windows again.");
    }
    if (window.pid !== pid)
      return refusal(
        "ownerMismatch",
        "Window " + windowId + " belongs to process " + window.pid + ", not " + pid + ".",
      );
    // X11 has one root window and one scale for every monitor, and element frames and points
    // are window-local, so moving a window between monitors changes nothing a ref means. A
    // window on another workspace or minimized is unmapped, which is_on_screen reports; that
    // and a driver restart are what invalidate refs here.
    const epoch = [
      deps.screen,
      driverGeneration,
      pid,
      windowId,
      window.is_on_screen === false ? "away" : "here",
    ].join(":");
    return { window, epoch };
  };

  /**
   * Private when a password field has focus, and whenever AT-SPI cannot say what has focus: a
   * filtered or truncated read cannot prove the window has no password field.
   */
  const privateFor = async (pid: number) => {
    const focus = await deps.secureFocus(pid);
    return focus.secure || !focus.known;
  };

  const read = async (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly epoch: string;
    readonly since: string | undefined;
    readonly screenshot: boolean;
    readonly query: string | undefined;
    readonly maxElements: number | undefined;
    readonly deadlineMs: number;
  }): Promise<HelperAnswer & { readonly result: ComputerUseObservation | ComputerUseRefusal }> => {
    const answer = await call(
      "get_window_state",
      {
        pid: input.pid,
        window_id: input.windowId,
        tree_format: "elements",
        include_screenshot: input.screenshot,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.maxElements === undefined ? {} : { max_elements: input.maxElements }),
      },
      input.deadlineMs,
    );
    if (answer === "deadline")
      return { result: refusal("busy", "Reading the window took too long.") };
    if (answer === "lost") return { result: refusal("helperUnavailable", "Cua Driver exited.") };
    if (isRefusal(answer)) return { result: answer };
    const decoded = decodeRead(answer.structured);
    if (answer.isError || decoded._tag === "None") {
      const code = driverRefusalCode(answer.structured);
      return {
        result: refusal(
          code === "window_not_found" || code === "window_id_not_found"
            ? "windowNotFound"
            : "targetRefused",
          answer.text.split("\n", 1)[0] || "Cua Driver could not read the window.",
        ),
      };
    }
    // The screenshot is declared from its own bytes, so the size the agent points in is the
    // size of the image it sees; an image those bytes do not describe is not declared at all.
    const offered = input.screenshot ? answer.images[0] : undefined;
    const info = offered ? computerUseImageInfo(offered.data) : undefined;
    const {
      screenshot_width: _width,
      screenshot_height: _height,
      screenshot_mime_type: _mime,
      ...unshot
    } = decoded.value;
    const state =
      offered && info && info.mimeType === offered.mimeType
        ? {
            ...unshot,
            screenshot_width: info.width,
            screenshot_height: info.height,
            screenshot_mime_type: info.mimeType,
          }
        : unshot;
    const privateMode = await privateFor(input.pid);
    // A password field's value never leaves, even when it does not have focus.
    const elements = (state.elements ?? []).map((element) => {
      if (element.role !== SECURE_ROLE || element.value === undefined) return element;
      const { value: _value, ...rest } = element;
      return rest;
    });
    const observation = observations.observe({
      read: { ...state, elements },
      since: input.since,
      epoch: input.epoch,
      scope: JSON.stringify([input.query ?? null, input.maxElements ?? null]),
      screenshot: input.screenshot,
      privateMode,
    });
    const key = input.pid + ":" + input.windowId;
    const known =
      observation.kind === "full"
        ? new Map<string, ComputerUseElement>()
        : (lastReads.get(key)?.elements ?? new Map());
    if (observation.kind === "full")
      for (const element of observation.elements) known.set(element.ref, element);
    else {
      for (const ref of observation.removed) known.delete(ref);
      for (const element of [...observation.added, ...observation.changed])
        known.set(element.ref, element);
    }
    lastReads.set(key, {
      observationId: observation.observationId,
      screenshot: observation.screenshot !== undefined,
      query: input.query,
      maxElements: input.maxElements,
      elements: known,
    });
    const image = observation.screenshot ? offered : undefined;
    return image ? { result: observation, image } : { result: observation };
  };

  const readiness = (deadlineMs: number) => readLinuxReadiness({ ...deps, call }, deadlineMs);

  const act = async (
    method: ComputerUseMethod,
    params: unknown,
    left: () => number,
  ): Promise<HelperAnswer> => {
    const generation = driverGeneration;
    const decoded = decodeAction(params);
    if (decoded._tag === "None")
      return {
        result: refusal("invalidRequest", "That action request does not match the protocol."),
      };
    const request = decoded.value;
    if (request.action !== method)
      return {
        result: refusal(
          "invalidRequest",
          "The frame asks for " + method + " and its params for " + request.action + ".",
        ),
      };
    const { pid, windowId } = request.target;
    const now = await locate(pid, windowId, left());
    if (isRefusal(now)) return { result: now };
    if (now.epoch !== request.target.epoch) {
      observations.forget(pid, windowId);
      return {
        result: refusal(
          "epochChanged",
          "The window moved, was hidden or shown, or the helper restarted. Observe it again.",
        ),
      };
    }
    const last = lastReads.get(pid + ":" + windowId);
    const privateMode = await privateFor(pid);
    const call_ = linuxDriverCall(request, {
      observations,
      elements: last?.elements ?? new Map(),
      privateMode,
      pointerAndKeysInBackground: deps.session.pointerAndKeysInBackground,
    });
    if (isRefusal(call_)) return { result: call_ };
    // Last check before input leaves: a stop, a driver restart or a passed deadline sends nothing.
    if (closed || generation !== driverGeneration)
      return {
        result: refusal("helperUnavailable", "The helper stopped or restarted. Observe again."),
      };
    if (left() <= 0)
      return { result: refusal("busy", "The deadline passed before anything was sent.") };
    const answer = await call(call_.tool, call_.args, left(), generation);
    if (answer === "deadline") return { result: computerUseDeadlineResult(request.delivery) };
    if (answer === "lost")
      return {
        result: {
          ...computerUseDeadlineResult(request.delivery),
          detail: "Cua Driver exited after the action was sent.",
        },
      };
    // The driver did not start, so nothing was sent.
    if (isRefusal(answer)) return { result: answer };
    const sent = linuxActionResult(request, answer, undefined);
    if (sent.outcome === "refused" || !last) return { result: sent };
    // Read the window back the way the agent last read it, as a diff of that observation.
    await deps.settle();
    if (closed) return { result: sent };
    const after = await read({
      pid,
      windowId,
      epoch: now.epoch,
      since: request.observationId,
      screenshot: last.screenshot,
      query: last.query,
      maxElements: last.maxElements,
      deadlineMs: Math.max(1, left()),
    });
    const observation = isRefusal(after.result) ? undefined : after.result;
    const result = linuxActionResult(request, answer, observation);
    return after.image && observation ? { result, image: after.image } : { result };
  };

  const handleNow = async (
    method: ComputerUseMethod,
    params: unknown,
    expiry: number,
  ): Promise<HelperAnswer> => {
    const left = () => expiry - deps.now();
    if (left() <= 0)
      return { result: refusal("busy", "The deadline passed while the request waited.") };
    const deadlineMs = left();
    if (method === "capabilities") return { result: linuxCapabilities(deps.session) };
    if (method === "permissions") return { result: await readiness(deadlineMs) };
    if (deps.session.unsupported !== undefined)
      return {
        result: {
          ...unsupportedComputerUseMethod(method, "linux"),
          message: deps.session.unsupported,
        },
      };
    if (deps.session.unavailable !== undefined)
      return { result: refusal("helperUnavailable", deps.session.unavailable) };
    if (method === "listWindows") {
      const list = await windows(deadlineMs);
      if (isRefusal(list)) return { result: list };
      return {
        result: {
          windows: list.map((entry): ComputerUseWindow => ({
            pid: entry.pid,
            windowId: entry.window_id,
            ...(entry.title === undefined ? {} : { title: entry.title }),
            ...(entry.app_name === undefined ? {} : { application: entry.app_name }),
            onScreen: entry.is_on_screen !== false,
          })),
        },
      };
    }
    if (method === "observe") {
      const decoded = decodeObserve(params);
      if (decoded._tag === "None")
        return {
          result: refusal("invalidRequest", "That observe request does not match the protocol."),
        };
      const request = decoded.value;
      const now = await locate(request.target.pid, request.target.windowId, deadlineMs);
      if (isRefusal(now)) return { result: now };
      return read({
        pid: request.target.pid,
        windowId: request.target.windowId,
        epoch: now.epoch,
        since: request.since,
        screenshot: request.screenshot,
        query: request.query,
        maxElements: request.maxElements,
        deadlineMs,
      });
    }
    if (method === "watch" || method === "unwatch")
      return { result: unsupportedComputerUseMethod(method, "linux") };
    if (ACTIONS.has(method)) return act(method, params, left);
    return { result: refusal("invalidRequest", method + " is not a computer use method.") };
  };

  return {
    handle: (method, params, deadlineMs) => {
      // One expiry from receipt: time spent queued behind other requests counts against it.
      const expiry = deps.now() + deadlineMs;
      const next = queue.then((): Promise<HelperAnswer> =>
        closed
          ? Promise.resolve({
              result: refusal("helperUnavailable", "The helper is shutting down."),
            })
          : handleNow(method, params, expiry),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    // Every caller (stdin closing, a signal) waits for the same shutdown, driver included.
    close: () =>
      (closing ??= (async () => {
        closed = true;
        const current = driver;
        driver = undefined;
        driverGeneration++;
        if (current)
          await current.then(
            (client) => client.close(),
            () => undefined,
          );
      })()),
  };
}
