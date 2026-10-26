import {
  WS_METHODS,
  type ServerGetStorageUsageInput,
  type StorageCleanInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as HostPressureMonitor from "../fleet/pressure/HostPressureMonitor.ts";
import * as StorageReclaim from "./StorageReclaim.ts";

/** The storage RPCs for one client session, kept here so ws.ts only spreads them in. */
export const storageRpcHandlers = Effect.fn("storageRpcHandlers")(function* (sessionId: string) {
  const reclaim = yield* StorageReclaim.StorageReclaim;
  const pressure = yield* HostPressureMonitor.HostPressureMonitor;
  return {
    [WS_METHODS.serverGetStorageUsage]: (input: ServerGetStorageUsageInput) =>
      reclaim.usage({ rescan: input.rescan === true }),
    [WS_METHODS.serverCleanUpStorageItems]: (input: StorageCleanInput) =>
      reclaim.clean({ items: input.items, actor: "client:" + sessionId }),
    [WS_METHODS.serverSubscribeDiskPressure]: () => pressure.disk,
  } as const;
});
