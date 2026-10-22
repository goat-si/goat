import type { FleetSnapshot } from "@goat/client-runtime/state/fleet";
import type { FleetMachineHeat } from "@goat/client-runtime/state/fleet-heat";
import { lazy, Suspense, useEffect, useState } from "react";

import { useUiStateStore } from "~/uiStateStore";

import type { FleetConnection } from "./fleetConnection";
import { fleetConsoleFrameClassName } from "./fleetConsoleFrame";

let fleetConsoleModule: Promise<typeof import("./FleetConsole")> | undefined;
/** The console chunk's single import, shared by `lazy` and anything that needs to await the chunk. */
export function loadFleetConsole() {
  fleetConsoleModule ??= import("./FleetConsole");
  return fleetConsoleModule;
}

const FleetConsole = lazy(loadFleetConsole);

/** True once the page has painted and the browser is idle, so the graph draws first. */
function useAfterFirstPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => setReady(true), { timeout: 1000 });
      return () => window.cancelIdleCallback(handle);
    }
    // Safari before 18 has no idle callback; the frame after next is past first paint.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return ready;
}

/** The Fleet telemetry console, loaded in its own chunk after the graph's first paint. */
export function FleetConsoleSlot(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly heat: ReadonlyMap<string, FleetMachineHeat>;
}) {
  const collapsed = useUiStateStore((state) => state.fleetConsoleCollapsed);
  const ready = useAfterFirstPaint();
  const placeholder = (
    <div
      aria-hidden
      data-fleet-console-placeholder
      className={fleetConsoleFrameClassName(collapsed)}
    />
  );
  if (!ready) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <FleetConsole {...props} />
    </Suspense>
  );
}
