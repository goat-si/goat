/**
 * DesktopFrames - the live picture of a desktop computer use session (#1370). The desktop's
 * helper captures one window at a time; this service decides which windows it captures and who
 * receives the pixels.
 *
 * A window is captured only while a viewer watches its session and the session's control is
 * active: not paused for a person's input, a takeover or a secret field, not idle between turns,
 * not ended. The window is the one the agent's latest admitted call named, and its app must be
 * one the control approved; the helper checks the owning app against the apps sent with it. Every
 * frame is checked again when it arrives, against the control as it is then and the apps it was
 * captured under, so a frame captured before a pause, a Stop or a narrowed grant never reaches a
 * viewer. Frames are capped at 480 px wide and 256 KiB, and the server passes at most one per
 * requested interval (500 ms at the least) whatever the desktop sends.
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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
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
/**
 * A grant cancelled elsewhere can change a control without a signal; reconcile this often while
 * anyone watches. Expiry is not left to this: the next one is scheduled.
 */
const RECONCILE_MS = 5_000;
/** How soon a capture request that failed to send is sent again. */
const RETRY_MS = 1_000;
/** The seq of a request that may or may not have reached the desktop; it matches no frame. */
const UNSENT = -1;

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
      /** When the control can next change without a signal, epoch ms. */
      readonly wakeAt: number;
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
  return { _tag: "open", ...target, apps: entry.state.apps, wakeAt: entry.state.wakeAt };
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

const sameApps = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((app) => b.includes(app));

/** What a viewer receives for a frame the desktop sent, or undefined when it is dropped. */
export function admitFrame(
  message: DesktopCuaFrame,
  current: { readonly seq: number; readonly targets: ReadonlyArray<Target> },
  gate: FrameGate | undefined,
): PreviewSessionFrameEvent | undefined {
  if (message.seq !== current.seq) return undefined;
  const target = current.targets.find((candidate) => candidate.key === message.key);
  // The window may have closed for capture since this was requested: a pause, a Stop, a new
  // window, or grants narrowed so the helper checked the app against apps no longer approved.
  if (
    target === undefined ||
    gate?._tag !== "open" ||
    gate.pid !== target.pid ||
    gate.windowId !== target.windowId ||
    !sameApps(gate.apps, target.apps)
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

/**
 * When the next frame of a session may be shown after one shown at `now`, or undefined when one
 * arriving at `now` is too soon. Lateness carries over by up to half an interval, so a desktop
 * timer's jitter does not halve the rate, while the long-run rate stays one per interval.
 */
function pace(now: number, nextAt: number | undefined, intervalMs: number) {
  if (nextAt !== undefined && now < nextAt) return undefined;
  return Math.max(nextAt ?? now, now - intervalMs / 2) + intervalMs;
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
  const nextFrameAt = new Map<string, number>();
  /**
   * The last request handed to the desktop. One that failed to send has an unknown fate: the
   * receiver keeps it to replay on reconnect, so it counts as requested, matches no frame, and is
   * sent again.
   */
  let current: { seq: number; targets: ReadonlyArray<Target> } = { seq: 0, targets: [] };
  let scheduled: number | undefined;
  const mutex = yield* Semaphore.make(1);
  const wake = yield* PubSub.sliding<void>(1);
  const timer = yield* FiberHandle.make<void, never>();
  const kick = PubSub.publish(wake, undefined).pipe(Effect.asVoid);
  // Any lease signal since a frame's check began may have closed its gate.
  const fence = Option.isSome(leases) ? yield* leases.value.subscribe : undefined;

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
        if (
          Option.isSome(desktop) &&
          (current.seq === UNSENT || !sameTargets(targets, current.targets))
        ) {
          const seq = yield* desktop.value.setCuaFrames(targets).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Could not send window capture targets to the desktop", {
                cause: String(cause),
              }),
            ),
            Effect.option,
          );
          current = { seq: Option.getOrElse(seq, () => UNSENT), targets };
        }
        yield* schedule(gates);
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

  /** Reconcile again when a watched control can next lapse, or soon after a failed send. */
  const schedule = Effect.fnUntraced(function* (gates: ReadonlyMap<string, FrameGate>) {
    const now = yield* Clock.currentTimeMillis;
    const due = [...gates.values()]
      .flatMap((gate) => (gate._tag === "open" && gate.wakeAt > now ? [gate.wakeAt] : []))
      .concat(current.seq === UNSENT ? [now + RETRY_MS] : []);
    const next = due.length === 0 ? undefined : Math.min(...due);
    if (next === scheduled) return;
    scheduled = next;
    if (next === undefined) return yield* FiberHandle.clear(timer);
    yield* FiberHandle.run(
      timer,
      Effect.sleep(next - now).pipe(
        Effect.andThen(Effect.sync(() => (scheduled = undefined))),
        Effect.andThen(kick),
      ),
      { startImmediately: true },
    );
  });

  /** A frame from the desktop, checked and fanned out with no reconcile in between. */
  const deliver = (message: DesktopCuaFrame) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const set = viewers.get(message.key);
        if (set === undefined || set.size === 0) return;
        if (fence !== undefined) yield* PubSub.takeUpTo(fence, Number.MAX_SAFE_INTEGER);
        const gate = yield* gateOf(message.key);
        if (fence !== undefined && (yield* PubSub.remaining(fence)) > 0) return;
        const event = admitFrame(message, current, gate);
        if (event === undefined) return;
        if (event.type === "frame") {
          const target = current.targets.find((candidate) => candidate.key === message.key);
          const now = yield* Clock.currentTimeMillis;
          const nextAt = pace(now, nextFrameAt.get(message.key), target?.intervalMs ?? 0);
          if (nextAt === undefined) return;
          nextFrameAt.set(message.key, nextAt);
        }
        const seq = (frameSeq.get(message.key) ?? 0) + 1;
        frameSeq.set(message.key, seq);
        for (const viewer of set) {
          viewer.told = event.type === "unavailable" ? event.reason : undefined;
          yield* Queue.offer(viewer.queue, event.type === "frame" ? { ...event, seq } : event);
        }
      }),
    );

  yield* Stream.fromPubSub(wake).pipe(
    Stream.runForEach(() => reconcile),
    Effect.forkScoped,
  );
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
    yield* desktop.value.cuaFrames.pipe(Stream.runForEach(deliver), Effect.forkScoped);
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
                    nextFrameAt.delete(input.sessionId);
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
