import { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  readLocalStorageValue,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";

const KEY = "goat:environment-voice-grant:v1";
const Grant = Schema.Struct({ id: Schema.String, environmentId: EnvironmentId });
const Choice = Schema.NullOr(Schema.Union([Grant, Schema.Literal("off")]));
export type EnvironmentSpeechGrant = typeof Grant.Type;

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

export function readEnvironmentSpeechChoice(): EnvironmentSpeechGrant | "off" | null {
  if (!revocations) return "off";
  const stored = readLocalStorageValue(KEY, null, Choice);
  return stored && stored !== "off" && revoked.has(stored.id) ? "off" : stored;
}

export function readEnvironmentSpeechGrant(): EnvironmentSpeechGrant | null {
  const choice = readEnvironmentSpeechChoice();
  return choice === "off" ? null : choice;
}

function subscribe(onChange: () => void) {
  const unsubscribe = subscribeLocalStorageKey(KEY, onChange);
  listeners.add(onChange);
  return () => {
    unsubscribe();
    listeners.delete(onChange);
  };
}

let snapshot: EnvironmentSpeechGrant | "off" | null = null;
function choiceSnapshot() {
  const choice = readEnvironmentSpeechChoice();
  if (choice === "off" || choice === null) snapshot = choice;
  else if (
    snapshot === null ||
    snapshot === "off" ||
    choice.id !== snapshot.id ||
    choice.environmentId !== snapshot.environmentId
  )
    snapshot = choice;
  return snapshot;
}
export const useEnvironmentSpeechChoice = () =>
  useSyncExternalStore(subscribe, choiceSnapshot, () => null);
export const useEnvironmentSpeechGrant = () => {
  const choice = useEnvironmentSpeechChoice();
  return choice === "off" ? null : choice;
};

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
      setLocalStorageItem(KEY, { id: randomUUID(), environmentId }, Choice);
    } else {
      setLocalStorageItem(KEY, "off", Choice);
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
