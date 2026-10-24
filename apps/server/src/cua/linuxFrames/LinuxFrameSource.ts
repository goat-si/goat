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
} from "../linuxHelper/x11WindowCapture.ts";
import { makeX11WindowPlacement } from "../x11WindowPlacement.ts";
import { encodeJpeg } from "./jpeg.ts";

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

/** Packed RGB as a JPEG within the frame byte limit, or undefined when it cannot fit. */
export function frameJpeg(rgb: Uint8Array, width: number, height: number): string | undefined {
  for (const quality of QUALITIES) {
    const jpeg = encodeJpeg(rgb, width, height, quality);
    if (jpeg.length <= PREVIEW_SESSION_FRAME_LIMITS.maxBytes)
      return Buffer.from(jpeg).toString("base64");
  }
  return undefined;
}

/** A capture's outcome as the message a desktop would send for it. */
const frameMessage = (
  seq: number,
  key: string,
  outcome: Exclude<FrameOutcome, { readonly skip: true }>,
): DesktopCuaFrame =>
  "frame" in outcome
    ? { version: 1, type: "cuaFrame", seq, key, mime: "image/jpeg", ...outcome.frame }
    : { version: 1, type: "cuaFrameUnavailable", seq, key, reason: outcome.unavailable };

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const environment = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hub = yield* PubSub.sliding<DesktopCuaFrame>(16);
  const loops = yield* FiberMap.make<string>();

  const session =
    Option.isSome(driver) && driver.value.driverSession !== undefined
      ? driver.value.driverSession
      : Effect.succeed(Option.none());

  const supported: Effect.Effect<boolean> =
    platform !== "linux"
      ? Effect.succeed(false)
      : session.pipe(
          Effect.map(
            (current) =>
              Option.isSome(current) &&
              current.value.display.some(
                (variable) => variable.name === "DISPLAY" && variable.value.trim() !== "",
              ),
          ),
        );

  const capture = Effect.fn("LinuxFrameSource.capture")(function* (target: Target) {
    const current = yield* session;
    if (Option.isNone(current)) return { unavailable: "unsupported" } satisfies FrameOutcome;
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    for (const variable of current.value.display) env[variable.name] = variable.value;
    const display = env.DISPLAY;
    if (display === undefined || display.trim() === "")
      return { unavailable: "unsupported" } satisfies FrameOutcome;
    // The window is still there, on this display, and the pid's (#1358).
    const placed = yield* Effect.promise(() =>
      makeX11WindowPlacement({ DISPLAY: display, XAUTHORITY: env.XAUTHORITY })([
        { pid: target.pid, windowId: target.windowId },
      ]),
    );
    if (placed === "other") return { unavailable: "windowGone" } satisfies FrameOutcome;
    if (placed === "unknown") return { unavailable: "captureFailed" } satisfies FrameOutcome;
    // A focused password field, or focus that cannot be read, shows nothing.
    const focus = yield* Effect.promise(() => makeSecureFocusProbe(gdbusRunner(env))(target.pid));
    if (!focus.known || focus.secure) return { unavailable: "private" } satisfies FrameOutcome;
    if (target.apps !== undefined) {
      const listed = new Map<number, ListedApp>();
      const sdk = yield* loadDriverSdk(fs, path).pipe(Effect.orElseSucceed(() => Option.none()));
      const socket = current.value.mcp.socketPath;
      if (Option.isSome(sdk) && socket)
        learnApps(
          yield* callDriverTool(sdk.value, socket, "list_apps", {}).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
          listed,
        );
      const verdict = scopeVerdict({
        name: "get_window_state",
        args: { pid: target.pid, window_id: target.windowId },
        apps: approvedApps(target.apps),
        appOf: (pid) => listed.get(pid),
      });
      if (verdict._tag !== "allow") return { unavailable: "appNotApproved" } satisfies FrameOutcome;
    }
    const shot = yield* Effect.promise(() =>
      captureX11Window(
        { DISPLAY: display, XAUTHORITY: env.XAUTHORITY },
        target.windowId,
        frameSize(target.maxWidth),
      ),
    );
    if ("refused" in shot) return refusalOutcome(shot.refused, shot.transient === true);
    const data = frameJpeg(shot.rgb, shot.width, shot.height);
    if (data === undefined) return { unavailable: "captureFailed" } satisfies FrameOutcome;
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

  const setTargets = (seq: number, targets: ReadonlyArray<Target>) =>
    Effect.gen(function* () {
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

export const layer = Layer.effect(LinuxFrameSource, make);
