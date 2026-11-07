import * as Layer from "effect/Layer";
import * as HostPressureMonitor from "./HostPressureMonitor.ts";
import * as FleetPressure from "./PressureNudger.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import * as ThreadReplicaService from "../../mcp/ThreadReplicaService.ts";

// Notices to orchestrating threads and launch advice; reads the monitor host status exposes.
export const layerPressureAdmission = FleetPressure.layerAdmission.pipe(
  Layer.provide(HostPressureMonitor.layer),
);
const layerThreadReplicas = ThreadReplicaService.layer.pipe(Layer.provide(layerPressureAdmission));
export const layerLaunchWatches = LaunchWatchService.layer.pipe(
  Layer.provideMerge(layerThreadReplicas),
  Layer.provide(layerPressureAdmission),
);
