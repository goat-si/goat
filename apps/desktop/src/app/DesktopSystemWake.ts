import type { DesktopSystemWakeEvent } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SYSTEM_WAKE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";

type PowerTransition = DesktopSystemWakeEvent["reason"];

/** Repeated macOS powerMonitor resume events within this window belong to the same wake. */
const RESUME_DEDUP_WINDOW_MS = 3_000;

/**
 * Tells the renderer when the machine wakes or the screen unlocks, so its
 * connections can check or replace sockets that died while asleep. A lid
 * close does not always change the window's visibility, so the renderer
 * cannot see this on its own. After a resume, SSH forwards that stopped
 * answering are closed so reconnects open fresh ones.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const transitions = yield* Queue.unbounded<PowerTransition>();

    yield* Effect.gen(function* () {
      // powerMonitor is only usable once the app is ready.
      yield* electronApp.whenReady;
      yield* Effect.all(
        (["suspend", "resume", "unlock-screen"] as const).map((transition) =>
          powerMonitor.onSimpleEvent(transition, () => Queue.offerUnsafe(transitions, transition)),
        ),
        { concurrency: "unbounded", discard: true },
      );
      // Wall-clock time: the monotonic clock does not advance during sleep on macOS.
      let suspendedAtMs: number | null = null;
      let lastResumeAtMs: number | null = null;
      for (;;) {
        const transition = yield* Queue.take(transitions);
        const nowMs = yield* Clock.currentTimeMillis;
        if (transition === "suspend") {
          suspendedAtMs = nowMs;
        }
        if (
          transition === "resume" &&
          suspendedAtMs === null &&
          lastResumeAtMs !== null &&
          nowMs - lastResumeAtMs < RESUME_DEDUP_WINDOW_MS
        ) {
          continue;
        }
        const event: DesktopSystemWakeEvent = {
          reason: transition,
          asleepMs:
            transition === "resume" && suspendedAtMs !== null
              ? Math.max(0, nowMs - suspendedAtMs)
              : null,
        };
        yield* Effect.logInfo("desktop.systemWake", event);
        yield* electronWindow.sendAll(SYSTEM_WAKE_CHANNEL, event);
        if (transition === "resume") {
          suspendedAtMs = null;
          lastResumeAtMs = nowMs;
          yield* sshEnvironment.revalidateTunnels.pipe(Effect.forkScoped);
        }
      }
    }).pipe(
      Effect.tapError((error) => Effect.logWarning("desktop.systemWake.unavailable", { error })),
      Effect.ignore,
      Effect.forkScoped,
    );
  }),
);
