import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubDisposableMachinesPatch, HubDisposableMachinesSaved } from "./disposableMachines.ts";

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
  connectDevicesHubProxy: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  cloudHolder: HubCloudHolder.pipe(Schema.withDecodingDefault(Effect.succeed("hub" as const))),
  /**
   * A cloud machine this hub creates gets its OpenCodex and joins as a Child when first used.
   * On by default, as before the switch existed; off stops new joins and keeps existing links.
   */
  autoJoinCloudMachines: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  devices: HubDevices.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** "Attach disposable machines": off, with no provisioners, until a person turns it on. */
  attachDisposableMachines: HubDisposableMachinesSaved.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type HubSettings = typeof HubSettings.Type;

export const HubSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  connectDevicesHubProxy: Schema.optionalKey(Schema.Boolean),
  cloudHolder: Schema.optionalKey(HubCloudHolder),
  autoJoinCloudMachines: Schema.optionalKey(Schema.Boolean),
  /** Replaces the whole map, as fleet.hosts does. */
  devices: Schema.optionalKey(HubDevices),
  /** Merged field by field; a person's session is required to change it. */
  attachDisposableMachines: Schema.optionalKey(HubDisposableMachinesPatch),
});

export const HUB_RELAY_WARNING_MAX_GB = 1_000_000;
/** Decimal gigabytes a day; 0 never warns. */
const RelayWarningGb = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: HUB_RELAY_WARNING_MAX_GB }),
);
export const DEFAULT_HUB_RELAY_WARNING_DEVICE_GB_PER_DAY = 5;
export const DEFAULT_HUB_RELAY_WARNING_HUB_GB_PER_DAY = 30;

/**
 * The server settings an environment reads when it is the hub. The relay thresholds only add a
 * warning to Hub and Fleet when one Child, or all of them together, sent that much through a Pen
 * relay in 24 hours; nothing ever stops a turn or a link because of them.
 */
export const HubServerSettingsFields = {
  hub: HubSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  hubRelayWarningDeviceGbPerDay: RelayWarningGb.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HUB_RELAY_WARNING_DEVICE_GB_PER_DAY)),
  ),
  hubRelayWarningHubGbPerDay: RelayWarningGb.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HUB_RELAY_WARNING_HUB_GB_PER_DAY)),
  ),
};
export const HubServerSettingsPatchFields = {
  hub: Schema.optionalKey(HubSettingsPatch),
  hubRelayWarningDeviceGbPerDay: Schema.optionalKey(RelayWarningGb),
  hubRelayWarningHubGbPerDay: Schema.optionalKey(RelayWarningGb),
};
