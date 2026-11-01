import type { RelayDeviceRegistrationRequest } from "@goat/contracts/relay";
import { ManagedRelay } from "@goat/client-runtime/relay";
import * as Schema from "effect/Schema";
import type { Preferences } from "../../persistence/mobile-preferences";

const isRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

export function invalidatesRegistration(error: unknown): boolean {
  if (!isRelayRequestFailedError(error)) return false;
  const tag = error.relayError?._tag;
  return (
    tag === "RelayAccountAccessDeniedError" ||
    tag === "RelayAccountEpochStaleError" ||
    tag === "RelayEnvironmentRelinkRequiredError" ||
    tag === "RelayMobileDeviceNotRegisteredError" ||
    tag === "RelayAuthInvalidError"
  );
}

export function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

export function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

export interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
}

export function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return observedPushToken ? { observedPushToken } : {};
}

export function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken
  );
}
