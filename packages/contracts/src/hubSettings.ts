import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * "hub": cloud launches from any device go to the hub's sign-ins. "auto": the least loaded
 * ready holder, as without a hub.
 */
export const HubCloudHolder = Schema.Literals(["hub", "auto"]);
export type HubCloudHolder = typeof HubCloudHolder.Type;

/**
 * GOAT's side of local fallback while the hub is unreachable. A goal hop to this device's own
 * sign-in also needs OpenCodex's per-device permission (OCX-11), read from the Home beforehand.
 */
export const HubDeviceSettings = Schema.Struct({
  localFallback: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type HubDeviceSettings = typeof HubDeviceSettings.Type;

/**
 * Keyed like fleet.hosts: an SSH alias, or "local" for this machine. The device that runs the
 * goal work reads its own "local" entry, because the hub may be the machine that is down.
 */
const HubDevices = Schema.Record(TrimmedNonEmptyString, HubDeviceSettings);

/** Server settings key `hub`, read on the environment that is the hub. */
export const HubSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  cloudHolder: HubCloudHolder.pipe(Schema.withDecodingDefault(Effect.succeed("hub" as const))),
  devices: HubDevices.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type HubSettings = typeof HubSettings.Type;

export const HubSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  cloudHolder: Schema.optionalKey(HubCloudHolder),
  /** Replaces the whole map, as fleet.hosts does. */
  devices: Schema.optionalKey(HubDevices),
});
