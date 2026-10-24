/**
 * LinuxFrameSource - live frames of a computer use session's window on a Linux server that runs
 * the driver itself, with no desktop app to capture for it (#1370). DesktopFrames hands it the
 * same targets it sends a desktop; each target is captured on its own interval and every frame
 * goes back through DesktopFrames' checks against the control.
 *
 * Each capture checks again, right before it, what the desktop's helper would: the window is
 * still on the X display the driver runs on and owned by the pid the agent named; no password
 * field of that pid has focus (unknown counts as private); and, when the control approved
 * certain apps, the pid's app is one of them. The pixels come from the window's own capture
 * (x11WindowCapture.ts), with the app asked to redraw first, so other apps' windows never show.
 * Frames are JPEG within PREVIEW_SESSION_FRAME_LIMITS.
 *
 * @module LinuxFrameSource
 */
import {
  type DesktopCuaFrame,
  type DesktopCuaFrames,
  PREVIEW_SESSION_FRAME_LIMITS,
  type PreviewSessionNoPicture,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "../ComputerUseScope.ts";
import * as CuaDriver from "../CuaDriver.ts";
import { callDriverTool, loadDriverSdk } from "../LinuxReadiness.ts";
import { gdbusRunner, makeSecureFocusProbe } from "../linuxHelper/atspiFocus.ts";
import {
  BUSY_CAPTURE,
  RESIZED_CAPTURE,
  SHARED_CAPTURE,
  STILL_DRAWING,
  captureX11Window,
  type X11WindowCapture,
} from "../linuxHelper/x11WindowCapture.ts";
import { makeX11WindowPlacement } from "../x11WindowPlacement.ts";
import { jpegSteps } from "./jpeg.ts";

type Target = DesktopCuaFrames["targets"][number];

export class LinuxFrameSource extends Context.Service<
  LinuxFrameSource,
  {
    /** Whether this server can capture its sessions' windows now: Linux, the driver on X. */
    readonly supported: Effect.Effect<boolean>;
    /** Replaces what is captured; frames carry this seq. */
    readonly setTargets: (seq: number, targets: ReadonlyArray<Target>) => Effect.Effect<void>;
    readonly frames: Stream.Stream<DesktopCuaFrame>;
  }
>()("goat/cua/linuxFrames/LinuxFrameSource") {}

/** JPEG qualities tried in turn until a frame fits PREVIEW_SESSION_FRAME_LIMITS.maxBytes. */
const QUALITIES = [70, 45] as const;

/** One capture's outcome: a frame, a reason there is none, or nothing to say this time. */
export type FrameOutcome =
  | { readonly frame: { readonly width: number; readonly height: number; readonly data: string } }
  | { readonly unavailable: PreviewSessionNoPicture }
  | { readonly skip: true };

/** The size to capture a window at: no wider than asked, never larger than the window. */
export const frameSize = (maxWidth: number) => (windowWidth: number, windowHeight: number) => {
  const width = Math.max(1, Math.min(maxWidth, windowWidth));
  return {
    width,
    height: Math.max(1, Math.round((windowHeight * width) / windowWidth)),
    windowWidth,
    windowHeight,
  };
};

/** A capture refusal as what a viewer is told; transient ones clear on the next capture. */
export function refusalOutcome(refused: string, transient: boolean): FrameOutcome {
  if (
    transient ||
    refused === BUSY_CAPTURE ||
    refused === RESIZED_CAPTURE ||
    refused === STILL_DRAWING
  )
    return { skip: true };
  // Another app's window over this one would show in it.
  if (refused === SHARED_CAPTURE) return { unavailable: "captureFailed" };
  return { unavailable: "unsupported" };
}

/** Encoding rows between turns of the event loop: a few milliseconds of work at a time. */
const ROWS_PER_TURN = 4;

/**
 * Packed RGB as a JPEG within the frame byte limit, or undefined when it cannot fit. Encoding
 * runs in short slices, so a large frame does not hold the server's event loop, and a capture
 * stopped meanwhile stops encoding at the next slice.
 */
export const frameJpeg = Effect.fn("LinuxFrameSource.frameJpeg")(function* (
  rgb: Uint8Array,
  width: number,
  height: number,
) {
  for (const quality of QUALITIES) {
    const steps = jpegSteps(rgb, width, height, quality);
    let rows = 0;
    let step = steps.next();
    while (!step.done) {
      if (++rows % ROWS_PER_TURN === 0)
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      step = steps.next();
    }
    if (step.value.length <= PREVIEW_SESSION_FRAME_LIMITS.maxBytes)
      return Buffer.from(step.value).toString("base64");
  }
  return undefined;
});

/** A capture's outcome as the message a desktop would send for it. */
const frameMessage = (
  seq: number,
  key: string,
  outcome: Exclude<FrameOutcome, { readonly skip: true }>,
): DesktopCuaFrame =>
  "frame" in outcome
    ? { version: 1, type: "cuaFrame", seq, key, mime: "image/jpeg", ...outcome.frame }
    : { version: 1, type: "cuaFrameUnavailable", seq, key, reason: outcome.unavailable };

/** The reads a capture makes, apart so tests can stand in for X, AT-SPI and the driver. */
export interface FrameIo {
  /** The driver's display environment, or none when the driver is not running on X. */
  readonly session: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
  readonly placement: (
    env: Readonly<Record<string, string>>,
    target: Target,
  ) => Promise<"same" | "other" | "unknown">;
  readonly focus: (
    env: Readonly<Record<string, string>>,
    pid: number,
  ) => Promise<{ readonly known: boolean; readonly secure: boolean }>;
  /** The driver's list_apps answer, or undefined when it cannot be read. */
  readonly listApps: Effect.Effect<unknown>;
  readonly capture: (
    env: Readonly<Record<string, string>>,
    target: Target,
  ) => Promise<X11WindowCapture>;
}

const isPrivate = (focus: { readonly known: boolean; readonly secure: boolean }) =>
  !focus.known || focus.secure;

export const makeLinuxFrameSource = Effect.fn("LinuxFrameSource.make")(function* (
  platform: string,
  io: FrameIo,
) {
  const hub = yield* PubSub.sliding<DesktopCuaFrame>(16);
  const loops = yield* FiberMap.make<string>();

  const supported: Effect.Effect<boolean> =
    platform !== "linux"
      ? Effect.succeed(false)
      : io.session.pipe(
          Effect.map((env) => Option.exists(env, (value) => (value.DISPLAY ?? "").trim() !== "")),
        );

  const capture = Effect.fn("LinuxFrameSource.capture")(function* (target: Target) {
    const current = yield* io.session;
    if (Option.isNone(current) || (current.value.DISPLAY ?? "").trim() === "")
      return { unavailable: "unsupported" } satisfies FrameOutcome;
    const env = current.value;
    // The window is still there, on this display, and the pid's (#1358).
    const placed = yield* Effect.promise(() => io.placement(env, target));
    if (placed === "other") return { unavailable: "windowGone" } satisfies FrameOutcome;
    if (placed === "unknown") return { unavailable: "captureFailed" } satisfies FrameOutcome;
    // A focused password field, or focus that cannot be read, shows nothing.
    if (isPrivate(yield* Effect.promise(() => io.focus(env, target.pid))))
      return { unavailable: "private" } satisfies FrameOutcome;
    if (target.apps !== undefined) {
      const listed = new Map<number, ListedApp>();
      // The listing the proxy judges agent calls by: a desktop app by its desktop id, and a
      // process without one by the app name of the windows list_apps nests under it (#1428).
      learnApps(yield* io.listApps, listed);
      const verdict = scopeVerdict({
        name: "get_window_state",
        args: { pid: target.pid, window_id: target.windowId },
        apps: approvedApps(target.apps),
        appOf: (pid) => listed.get(pid),
      });
      if (verdict._tag !== "allow") return { unavailable: "appNotApproved" } satisfies FrameOutcome;
    }
    const shot = yield* Effect.promise(() => io.capture(env, target));
    if ("refused" in shot) return refusalOutcome(shot.refused, shot.transient === true);
    const data = yield* frameJpeg(shot.rgb, shot.width, shot.height);
    if (data === undefined) return { unavailable: "captureFailed" } satisfies FrameOutcome;
    // A password field focused while the window was read or encoded keeps the frame back.
    if (isPrivate(yield* Effect.promise(() => io.focus(env, target.pid))))
      return { unavailable: "private" } satisfies FrameOutcome;
    return { frame: { width: shot.width, height: shot.height, data } } satisfies FrameOutcome;
  });

  const loop = (seq: number, target: Target) =>
    capture(target).pipe(
      Effect.orElseSucceed((): FrameOutcome => ({ unavailable: "captureFailed" })),
      Effect.flatMap((outcome) =>
        "skip" in outcome
          ? Effect.void
          : PubSub.publish(hub, frameMessage(seq, target.key, outcome)),
      ),
      Effect.andThen(
        Effect.sleep(Math.max(PREVIEW_SESSION_FRAME_LIMITS.minIntervalMs, target.intervalMs)),
      ),
      Effect.forever,
    );

  const setTargets = Effect.fn("LinuxFrameSource.setTargets")(function* (
    seq: number,
    targets: ReadonlyArray<Target>,
  ) {
    yield* FiberMap.clear(loops);
    if (platform !== "linux") return;
    for (const target of targets) yield* FiberMap.run(loops, target.key, loop(seq, target));
  });

  return LinuxFrameSource.of({
    supported,
    setTargets,
    frames: Stream.fromPubSub(hub),
  });
});

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const environment = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driverSession =
    Option.isSome(driver) && driver.value.driverSession !== undefined
      ? driver.value.driverSession
      : Effect.succeedNone;
  // The server's environment with the display the driver was started on.
  const session = driverSession.pipe(
    Effect.map(
      Option.map((current) => {
        const env: Record<string, string> = Object.fromEntries(
          Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        for (const variable of current.display) env[variable.name] = variable.value;
        return env;
      }),
    ),
  );
  const listApps = Effect.gen(function* () {
    const current = yield* driverSession;
    const socket = Option.isSome(current) ? current.value.mcp.socketPath : undefined;
    const sdk = yield* loadDriverSdk(fs, path).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(sdk) || !socket) return undefined;
    return yield* callDriverTool(sdk.value, socket, "list_apps", {}).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  });
  const display = (env: Readonly<Record<string, string>>) => ({
    DISPLAY: env.DISPLAY ?? "",
    XAUTHORITY: env.XAUTHORITY,
  });
  return yield* makeLinuxFrameSource(platform, {
    session,
    placement: (env, target) =>
      makeX11WindowPlacement(display(env))([{ pid: target.pid, windowId: target.windowId }]),
    focus: (env, pid) => makeSecureFocusProbe(gdbusRunner(env))(pid),
    listApps,
    capture: (env, target) =>
      captureX11Window(display(env), target.windowId, frameSize(target.maxWidth)),
  });
});

export const layer = Layer.effect(LinuxFrameSource, make);
