import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type { RelayRateLimitOperation } from "@goat/contracts/relayErrors";

export const DEFAULT_LIMITS = {
  environmentLinks: 10,
  mobileDevices: 10,
  tunnels: 1,
  link_challenge: 20,
  link: 10,
  dpop_token: 120,
  connect: 120,
  mobile_registration: 30,
  activity_publish: 600,
} as const;
export interface Limits {
  readonly environmentLinks: number;
  readonly mobileDevices: number;
  readonly tunnels: number;
  readonly link_challenge: number;
  readonly link: number;
  readonly dpop_token: number;
  readonly connect: number;
  readonly mobile_registration: number;
  readonly activity_publish: number;
}
export type HourlyOperation = Exclude<
  RelayRateLimitOperation,
  "mobile_registration" | "activity_publish"
>;
export const HOURLY_OPERATIONS: ReadonlyArray<HourlyOperation> = [
  "link_challenge",
  "link",
  "dpop_token",
  "connect",
];
const positive = Schema.NumberFromString.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);
const setting = (key: string, value: number) =>
  Config.schema(positive, key).pipe(Config.withDefault(value));
export const config = Config.all({
  environmentLinks: setting("RELAY_MAX_ENVIRONMENT_LINKS", 10),
  mobileDevices: setting("RELAY_MAX_MOBILE_DEVICES", 10),
  tunnels: setting("RELAY_DEFAULT_MAX_TUNNELS", 1),
  link_challenge: setting("RELAY_RATE_LINK_CHALLENGE_PER_HOUR", 20),
  link: setting("RELAY_RATE_LINK_PER_HOUR", 10),
  dpop_token: setting("RELAY_RATE_DPOP_TOKEN_PER_HOUR", 120),
  connect: setting("RELAY_RATE_CONNECT_PER_HOUR", 120),
  mobile_registration: setting("RELAY_RATE_MOBILE_REGISTRATION_PER_MINUTE", 30),
  activity_publish: setting("RELAY_RATE_ACTIVITY_PUBLISH_PER_MINUTE", 600),
});
export class AccountLimits extends Context.Service<AccountLimits, Limits>()(
  "goat-relay/accounts/AccountLimits",
) {}
