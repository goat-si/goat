// @effect-diagnostics-next-line nodeBuiltinImport:off -- a random grant id and a digest of the switch.
import * as NodeCrypto from "node:crypto";

import {
  DISPOSABLE_SWITCH_DAYS,
  type HubSettings,
  type ServerSettings,
  ServerSettingsError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Set only by the person-verified settings path; every other writer leaves the switch as it is. */
const PersonSwitchConsent = Context.Reference<boolean>("goat/hub/disposable/PersonSwitchConsent", {
  defaultValue: () => false,
});
/** Runs a settings write as the person path does, once a person has been verified. */
export const withPersonConsent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, PersonSwitchConsent, true);

// Everything the person consented to, with the hub switch: a change to any of it is a new consent.
const consent = (hub: HubSettings) => {
  const { enabled, provisioners, cap, nameRule, expiresAt } = hub.attachDisposableMachines;
  return JSON.stringify([hub.enabled, enabled, provisioners, cap, nameRule, expiresAt]);
};

/**
 * The switch is off whenever the hub is, and turning it off clears its expiry, so a switch that
 * turns on with an expiry has one a person chose (held to 30 days ahead; a past one stays closed)
 * and one without gets 30 days. Each consent change while it is or becomes on gets a new grantId.
 */
const stampDisposableSwitch = (
  current: ServerSettings,
  next: ServerSettings,
): Effect.Effect<ServerSettings> => {
  const before = current.hub.attachDisposableMachines;
  const asked = next.hub.attachDisposableMachines;
  const value = asked.enabled && !next.hub.enabled ? { ...asked, enabled: false } : asked;
  const hub = { ...next.hub, attachDisposableMachines: value };
  if (consent(current.hub) === consent(hub) || (!before.enabled && !value.enabled))
    return Effect.succeed(value === asked ? next : { ...next, hub });
  return DateTime.now.pipe(
    Effect.map((now): ServerSettings => {
      const ceiling = DateTime.add(now, { days: DISPOSABLE_SWITCH_DAYS });
      const expiresAt = !value.enabled
        ? null
        : value.expiresAt === null
          ? before.enabled
            ? null
            : DateTime.formatIso(ceiling)
          : Date.parse(value.expiresAt) > DateTime.toEpochMillis(ceiling)
            ? DateTime.formatIso(ceiling)
            : value.expiresAt;
      return {
        ...next,
        hub: {
          ...hub,
          attachDisposableMachines: { ...value, expiresAt, grantId: NodeCrypto.randomUUID() },
        },
      };
    }),
  );
};

// What the person sets; the stamp itself may still close the switch or clear its expiry.
const personFields = (hub: HubSettings) => {
  const { enabled, provisioners, cap, nameRule, expiresAt } = hub.attachDisposableMachines;
  return JSON.stringify([enabled, provisioners, cap, nameRule, expiresAt]);
};

/**
 * Wraps a settings commit's update so every write path, patch or not, stamps the switch, and only
 * the person path may ask for a change to it.
 */
export const withDisposableStamp =
  <E, R>(update: (current: ServerSettings) => Effect.Effect<ServerSettings, E, R>) =>
  (current: ServerSettings) =>
    update(current).pipe(
      Effect.flatMap((next) =>
        Effect.gen(function* () {
          if (personFields(current.hub) !== personFields(next.hub) && !(yield* PersonSwitchConsent))
            return yield* new ServerSettingsError({
              settingsPath: "settings",
              operation: "normalize",
              cause: new Error("Only a person in Settings changes Attach disposable machines."),
            });
          return yield* stampDisposableSwitch(current, next);
        }),
      ),
    );

export type DisposableSwitch =
  | { readonly open: true; readonly grant: string }
  | { readonly open: false; readonly reason: "switch_off" | "switch_expired" };

/**
 * Whether the switch admits attach work at `nowMs`, and under which grant. The grant covers the
 * grantId and the consent itself, so a change written without a new grantId (a hand edit of the
 * settings file) still ends every grant taken before it. A switch with no grantId is off.
 * Every write holds the expiry to 30 days ahead, so one farther ahead (a hand edit) reads closed.
 */
export const disposableSwitch = (hub: HubSettings, nowMs: number): DisposableSwitch => {
  const value = hub.attachDisposableMachines;
  if (!hub.enabled || !value.enabled || value.grantId === null)
    return { open: false, reason: "switch_off" };
  const expiresAtMs = value.expiresAt === null ? Number.NaN : Date.parse(value.expiresAt);
  if (!(expiresAtMs > nowMs) || expiresAtMs > nowMs + DISPOSABLE_SWITCH_DAYS * 86_400_000)
    return { open: false, reason: "switch_expired" };
  const digest = NodeCrypto.createHash("sha256").update(consent(hub)).digest("hex").slice(0, 16);
  return { open: true, grant: `${value.grantId}:${digest}` };
};
