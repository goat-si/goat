import { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";

const KEY = "goat:environment-voice-grant:v1";
const Grant = Schema.NullOr(Schema.Struct({ id: Schema.String, environmentId: EnvironmentId }));
export type EnvironmentSpeechGrant = NonNullable<typeof Grant.Type>;

export const useEnvironmentSpeechGrant = () => useLocalStorage(KEY, null, Grant)[0];
export const readEnvironmentSpeechGrant = () => readLocalStorageValue(KEY, null, Grant);
export function chooseEnvironmentSpeech(environmentId: typeof EnvironmentId.Type | null) {
  writeLocalStorageValue(
    KEY,
    environmentId ? { id: randomUUID(), environmentId } : null,
    null,
    Grant,
  );
}
export function isEnvironmentSpeechGrantCurrent(grant: EnvironmentSpeechGrant) {
  const current = readEnvironmentSpeechGrant();
  return current?.id === grant.id && current.environmentId === grant.environmentId;
}
