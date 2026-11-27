import * as Context from "effect/Context";
import * as Latch from "effect/Latch";

export const DesktopShellDiscovery = Context.Reference<Latch.Latch>(
  "goat/resourceTelemetry/DesktopShellDiscovery",
  { defaultValue: () => Latch.makeUnsafe(false) },
);
