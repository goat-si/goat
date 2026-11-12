import * as Context from "effect/Context";
import * as Latch from "effect/Latch";

/**
 * Opened when this server's PATH changes after startup. A latch, so any number of changes while
 * provider statuses are being refreshed cost one more refresh, and none is lost.
 */
export const HostPathChanged = Context.Reference<Latch.Latch>("goat/provider/HostPathChanged", {
  defaultValue: () => Latch.makeUnsafe(false),
});
