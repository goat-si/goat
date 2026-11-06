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

// A revocation applies in this tab before storage is touched, so a failed write cannot keep it alive.
const revoked = new Set<string>();
const listeners = new Set<() => void>();

export function readEnvironmentSpeechGrant(): EnvironmentSpeechGrant | null {
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

/** Returns false when the choice could not be saved; this tab still stops using the old grant. */
export function chooseEnvironmentSpeech(environmentId: EnvironmentId | null): boolean {
  const previous = readEnvironmentSpeechGrant();
  if (previous) revoked.add(previous.id);
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
  return saved;
}

export function isEnvironmentSpeechGrantCurrent(grant: EnvironmentSpeechGrant) {
  const current = readEnvironmentSpeechGrant();
  return current?.id === grant.id && current.environmentId === grant.environmentId;
}
