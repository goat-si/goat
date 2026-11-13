// @effect-diagnostics-next-line nodeBuiltinImport:off -- a random grant id and a digest of the switch.
import * as NodeCrypto from "node:crypto";

import { DISPOSABLE_SWITCH_DAYS, type HubSettings, type ServerSettings } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// Everything the person consented to, with the hub switch: a change to any of it is a new consent.
const consent = (hub: HubSettings) => {
  const { enabled, provisioners, cap, nameRule, expiresAt } = hub.attachDisposableMachines;
  return JSON.stringify([hub.enabled, enabled, provisioners, cap, nameRule, expiresAt]);
};

/**
 * Gives the switch a new grantId whenever the person's consent changes, and an expiry 30 days
 * ahead when it is on without a future one.
 */
const stampDisposableSwitch = (
  current: ServerSettings,
  next: ServerSettings,
): Effect.Effect<ServerSettings> =>
  consent(current.hub) === consent(next.hub)
    ? Effect.succeed(next)
    : DateTime.now.pipe(
        Effect.map((now): ServerSettings => {
          const value = next.hub.attachDisposableMachines;
          const expired =
            value.expiresAt === null || Date.parse(value.expiresAt) <= DateTime.toEpochMillis(now);
          const expiresAt =
            value.enabled && expired
              ? DateTime.formatIso(DateTime.add(now, { days: DISPOSABLE_SWITCH_DAYS }))
              : value.expiresAt;
          return {
            ...next,
            hub: {
              ...next.hub,
              attachDisposableMachines: { ...value, expiresAt, grantId: NodeCrypto.randomUUID() },
            },
          };
        }),
      );

/** Wraps a settings commit's update so every write path, patch or not, stamps the switch. */
export const withDisposableStamp =
  <E, R>(update: (current: ServerSettings) => Effect.Effect<ServerSettings, E, R>) =>
  (current: ServerSettings) =>
    update(current).pipe(Effect.flatMap((next) => stampDisposableSwitch(current, next)));

export type DisposableSwitch =
  | { readonly open: true; readonly grant: string }
  | { readonly open: false; readonly reason: "switch_off" | "switch_expired" };

/**
 * Whether the switch admits attach work at `nowMs`, and under which grant. The grant covers the
 * grantId and the consent itself, so a change written without a new grantId (a hand edit of the
 * settings file) still ends every grant taken before it. A switch with no grantId is off.
 */
export const disposableSwitch = (hub: HubSettings, nowMs: number): DisposableSwitch => {
  const value = hub.attachDisposableMachines;
  if (!hub.enabled || !value.enabled || value.grantId === null)
    return { open: false, reason: "switch_off" };
  if (value.expiresAt === null || !(Date.parse(value.expiresAt) > nowMs))
    return { open: false, reason: "switch_expired" };
  const digest = NodeCrypto.createHash("sha256").update(consent(hub)).digest("hex").slice(0, 16);
  return { open: true, grant: `${value.grantId}:${digest}` };
};
