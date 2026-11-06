import { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  readLocalStorageValue,
  removeLocalStorageItem,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";

const KEY = "goat:environment-voice-grant:v1";
const Grant = Schema.NullOr(Schema.Struct({ id: Schema.String, environmentId: EnvironmentId }));
export type EnvironmentSpeechGrant = NonNullable<typeof Grant.Type>;

// A revocation applies in open tabs before storage is touched, so a failed write cannot keep it alive
// while they run. Only a reload after a failed write can bring the stored grant back.
const revoked = new Set<string>();
const listeners = new Set<() => void>();
const revocations =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`${KEY}:revoked`);

function revoke(id: string) {
  revoked.add(id);
  for (const listener of listeners) listener();
}

revocations?.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data === "string") revoke(event.data);
});

export function readEnvironmentSpeechGrant(): EnvironmentSpeechGrant | null {
  // Without a channel a revocation could not reach other tabs, so environment dictation stays off.
  if (!revocations) return null;
  const stored = readLocalStorageValue(KEY, null, Grant);
  return stored && !revoked.has(stored.id) ? stored : null;
}

function subscribe(onChange: () => void) {
  const unsubscribe = subscribeLocalStorageKey(KEY, onChange);
  listeners.add(onChange);
  return () => {
    unsubscribe();
    listeners.delete(onChange);
  };
}

let snapshot: EnvironmentSpeechGrant | null = null;
function grantSnapshot() {
  const grant = readEnvironmentSpeechGrant();
  if (grant?.id !== snapshot?.id || grant?.environmentId !== snapshot?.environmentId) {
    snapshot = grant;
  }
  return snapshot;
}

export const useEnvironmentSpeechGrant = () =>
  useSyncExternalStore(subscribe, grantSnapshot, () => null);

/** "unsaved" still stops open tabs from using the old grant; "unsupported" changes nothing. */
export function chooseEnvironmentSpeech(
  environmentId: EnvironmentId | null,
): "saved" | "unsaved" | "unsupported" {
  if (environmentId && !revocations) return "unsupported";
  const previous = readEnvironmentSpeechGrant();
  if (previous) {
    revoked.add(previous.id);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel takes no origin
    revocations?.postMessage(previous.id);
  }
  let saved = true;
  try {
    if (environmentId) {
      setLocalStorageItem(KEY, { id: randomUUID(), environmentId }, Grant);
    } else {
      removeLocalStorageItem(KEY);
    }
  } catch (error) {
    console.error("[voice] Could not save the dictation choice.", error);
    saved = false;
  }
  for (const listener of listeners) listener();
  return saved ? "saved" : "unsaved";
}

export function isEnvironmentSpeechGrantCurrent(grant: EnvironmentSpeechGrant) {
  const current = readEnvironmentSpeechGrant();
  return current?.id === grant.id && current.environmentId === grant.environmentId;
}
