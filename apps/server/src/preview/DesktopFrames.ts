/**
 * DesktopFrames - the live picture of a desktop computer use session (#1370). The desktop's
 * helper captures one window at a time; this service decides which windows it captures and who
 * receives the pixels.
 *
 * A window is captured only while a viewer watches its session and the session's control is
 * active: not paused for a person's input, a takeover or a secret field, not idle between turns,
 * not ended. The window is the one the agent's latest admitted call named, and its app must be
 * one the control approved; the helper checks the owning app against the apps sent with it. Every
 * frame is checked again when it arrives, so a frame captured before a pause or a Stop never
 * reaches a viewer, and frames are capped at 480 px wide, 2 a second and 256 KiB.
 *
 * @module DesktopFrames
 */
import {
  type DesktopCuaFrame,
  type DesktopCuaFrames,
  PREVIEW_SESSION_FRAME_LIMITS,
  type PreviewSessionFrameEvent,
  type PreviewSessionFramesInput,
  type PreviewSessionNoPicture,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export class DesktopFrames extends Context.Service<
  DesktopFrames,
  {
    /** One viewer's frames of a desktop session, or why there are none, until it unsubscribes. */
    readonly frames: (input: PreviewSessionFramesInput) => Stream.Stream<PreviewSessionFrameEvent>;
  }
>()("goat/preview/DesktopFrames") {}

const DESKTOP_PREFIX = "desktop:";
/** Expiry changes a control without a signal; reconcile this often while anyone watches. */
const RECONCILE_MS = 5_000;

type Target = DesktopCuaFrames["targets"][number];
type Entry = {
  readonly control: ComputerUseLeases.ComputerUseControl;
  readonly state: ComputerUseLeases.ComputerUseControlState;
};

export type FrameGate =
  | {
      readonly _tag: "open";
      readonly pid: number;
      readonly windowId: number;
      readonly apps: ReadonlyArray<string> | undefined;
    }
  | { readonly _tag: "closed"; readonly reason: PreviewSessionNoPicture };

const closed = (reason: PreviewSessionNoPicture): FrameGate => ({ _tag: "closed", reason });

/** Whether a session's window may be captured now, and if not, what its viewers are told. */
export function frameGate(
  entry: Entry | undefined,
  detection: ComputerUseLeases.ComputerUseDetection,
): FrameGate {
  if (entry === undefined || entry.state._tag === "ended") return closed("stopped");
  if (entry.state._tag === "paused")
    return closed(entry.state.reason === "private" ? "private" : "paused");
  if (entry.control.idle === true) return closed("paused");
  if (!detection.frames) return closed("unsupported");
  const target = entry.control.target;
  if (target === undefined) return closed("windowUnknown");
  return { _tag: "open", ...target, apps: entry.state.apps };
}

export interface ViewerAsk {
  readonly maxWidth: number;
  readonly intervalMs: number;
}

/**
 * The captures to ask for: one per watched session with an open gate, as wide as its widest
 * viewer and as often as its most frequent one, both within the limits whatever a viewer asked.
 */
export function planFrames(
  gates: ReadonlyMap<string, FrameGate>,
  asks: ReadonlyMap<string, ReadonlyArray<ViewerAsk>>,
): ReadonlyArray<Target> {
  const targets: Array<Target> = [];
  for (const [key, viewers] of [...asks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const gate = gates.get(key);
    if (gate?._tag !== "open" || viewers.length === 0) continue;
    targets.push({
      key,
      pid: gate.pid,
      windowId: gate.windowId,
      ...(gate.apps === undefined ? {} : { apps: [...gate.apps] }),
      maxWidth: Math.min(
        PREVIEW_SESSION_FRAME_LIMITS.maxWidth,
        Math.max(...viewers.map((viewer) => viewer.maxWidth)),
      ),
      intervalMs: Math.max(
        PREVIEW_SESSION_FRAME_LIMITS.minIntervalMs,
        Math.min(...viewers.map((viewer) => viewer.intervalMs)),
      ),
    });
  }
  return targets;
}

/** What a viewer receives for a frame the desktop sent, or undefined when it is dropped. */
export function admitFrame(
  message: DesktopCuaFrame,
  current: { readonly seq: number; readonly targets: ReadonlyArray<Target> },
  gate: FrameGate | undefined,
): PreviewSessionFrameEvent | undefined {
  if (message.seq !== current.seq) return undefined;
  const target = current.targets.find((candidate) => candidate.key === message.key);
  // The window may have closed for capture since this was requested: a pause, a Stop, a new window.
  if (
    target === undefined ||
    gate?._tag !== "open" ||
    gate.pid !== target.pid ||
    gate.windowId !== target.windowId
  )
    return undefined;
  if (message.type === "cuaFrameUnavailable")
    return { type: "unavailable", reason: message.reason };
  // Base64 is 4 characters for every 3 bytes.
  const bytes = Math.floor((message.data.length * 3) / 4);
  if (bytes > PREVIEW_SESSION_FRAME_LIMITS.maxBytes || message.width > target.maxWidth)
    return { type: "unavailable", reason: "captureFailed" };
  return {
    type: "frame",
    seq: 0,
    width: message.width,
    height: message.height,
    mime: message.mime,
    data: message.data,
  };
}

const sameTargets = (a: ReadonlyArray<Target>, b: ReadonlyArray<Target>) =>
  JSON.stringify(a) === JSON.stringify(b);

interface Viewer extends ViewerAsk {
  readonly queue: Queue.Queue<PreviewSessionFrameEvent>;
  /** The last no-picture reason it was told, so a reason goes out once per change. */
  told: PreviewSessionNoPicture | undefined;
}

const make = Effect.gen(function* () {
  const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const desktop = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  const viewers = new Map<string, Set<Viewer>>();
  const frameSeq = new Map<string, number>();
  let current: { seq: number; targets: ReadonlyArray<Target> } = { seq: 0, targets: [] };
  const mutex = yield* Semaphore.make(1);
  const wake = yield* PubSub.sliding<void>(1);

  const gateOf = Effect.fn("DesktopFrames.gateOf")(function* (key: string) {
    if (Option.isNone(leases)) return closed("unsupported");
    const detection = yield* leases.value.detection;
    const entry = (yield* leases.value.sessions).find(
      ({ control }) => DESKTOP_PREFIX + control.controlId === key,
    );
    return frameGate(entry, detection);
  });

  const reconcile = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const gates = new Map<string, FrameGate>();
        const asks = new Map<string, ReadonlyArray<ViewerAsk>>();
        for (const [key, set] of viewers) {
          if (set.size === 0) continue;
          gates.set(key, yield* gateOf(key));
          asks.set(key, [...set]);
        }
        const targets = planFrames(gates, asks);
        if (Option.isSome(desktop) && !sameTargets(targets, current.targets)) {
          const seq = yield* desktop.value.setCuaFrames(targets).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Could not send window capture targets to the desktop", {
                cause: String(cause),
              }),
            ),
            Effect.option,
          );
          // An unsent change leaves the old targets in force; their frames are still gated.
          if (Option.isSome(seq)) current = { seq: seq.value, targets };
        }
        for (const [key, set] of viewers) {
          const gate = gates.get(key);
          for (const viewer of set) {
            const reason = gate === undefined || gate._tag === "open" ? undefined : gate.reason;
            if (reason !== undefined && viewer.told !== reason)
              yield* Queue.offer(viewer.queue, { type: "unavailable", reason });
            viewer.told = reason;
          }
        }
      }),
    )
    .pipe(Effect.withSpan("DesktopFrames.reconcile"));

  yield* Stream.fromPubSub(wake).pipe(
    Stream.runForEach(() => reconcile),
    Effect.forkScoped,
  );
  const kick = PubSub.publish(wake, undefined).pipe(Effect.asVoid);
  if (Option.isSome(leases)) {
    const subscription = yield* leases.value.subscribe;
    yield* PubSub.take(subscription).pipe(Effect.andThen(kick), Effect.forever, Effect.forkScoped);
  }
  yield* Effect.sleep(RECONCILE_MS).pipe(
    Effect.andThen(Effect.suspend(() => (viewers.size > 0 ? kick : Effect.void))),
    Effect.forever,
    Effect.forkScoped,
  );
  if (Option.isSome(desktop)) {
    // Readiness says whether the helper sends frames at all.
    yield* desktop.value.cuaSafety.pipe(
      Stream.filter((report) => report.type === "cuaReadiness"),
      Stream.runForEach(() => kick),
      Effect.forkScoped,
    );
    yield* desktop.value.cuaFrames.pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          const set = viewers.get(message.key);
          if (set === undefined || set.size === 0) return;
          const event = admitFrame(message, current, yield* gateOf(message.key));
          if (event === undefined) return;
          const seq = (frameSeq.get(message.key) ?? 0) + 1;
          frameSeq.set(message.key, seq);
          for (const viewer of set) {
            viewer.told = event.type === "unavailable" ? event.reason : undefined;
            yield* Queue.offer(viewer.queue, event.type === "frame" ? { ...event, seq } : event);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }

  const frames = (input: PreviewSessionFramesInput): Stream.Stream<PreviewSessionFrameEvent> =>
    input.sessionId.startsWith(DESKTOP_PREFIX)
      ? Stream.unwrap(
          Effect.gen(function* () {
            const viewer: Viewer = {
              maxWidth: input.maxWidth,
              intervalMs: input.frameIntervalMs,
              // Only the newest event matters; a slow client never builds a backlog.
              queue: yield* Queue.sliding<PreviewSessionFrameEvent>(1),
              told: undefined,
            };
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const set = viewers.get(input.sessionId) ?? new Set<Viewer>();
                set.add(viewer);
                viewers.set(input.sessionId, set);
              }),
              () =>
                Effect.suspend(() => {
                  const set = viewers.get(input.sessionId);
                  set?.delete(viewer);
                  if (set?.size === 0) {
                    viewers.delete(input.sessionId);
                    frameSeq.delete(input.sessionId);
                  }
                  return reconcile;
                }),
            );
            yield* reconcile;
            return Stream.fromQueue(viewer.queue);
          }),
        )
      : // A browser session's pixels come through its own preview stream.
        Stream.succeed<PreviewSessionFrameEvent>({
          type: "unavailable",
          reason: "unsupported",
        }).pipe(Stream.concat(Stream.never));

  return DesktopFrames.of({ frames });
});

export const layer = Layer.effect(DesktopFrames, make);
