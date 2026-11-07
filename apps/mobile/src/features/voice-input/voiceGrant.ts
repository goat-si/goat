import type { EnvironmentId } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { uuidv4 } from "../../lib/uuid";
import { createVoiceGrantStorage, type VoiceGrant } from "./voiceGrantStorage";

const key = "goat.voice.environment-grant.v1";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const marker = () => new File(Paths.document, "goat-voice-grant-id");
const storage = createVoiceGrantStorage({
  readSecret: () => SecureStore.getItemAsync(key, options),
  writeSecret: (value) => SecureStore.setItem(key, value, options),
  // iOS can keep keychain items across a reinstall while the app's documents are erased.
  readMarker: () => {
    const file = marker();
    return file.exists ? file.textSync() : null;
  },
  writeMarker: (value) => marker().writeSync(value),
  newId: uuidv4,
});

async function readGrant(): Promise<VoiceGrant | null> {
  await whenProtectedDataAvailable();
  return storage.read();
}
const stored = Atom.make(
  Effect.tryPromise({
    try: readGrant,
    catch: (cause) => new Error("Could not read voice consent", { cause }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Environment dictation stays off: voice consent is unreadable", error),
    ),
  ),
).pipe(Atom.keepAlive);
const choice = Atom.make<VoiceGrant | null | undefined>(undefined).pipe(Atom.keepAlive);
export const voiceGrantAtom = Atom.make((get) => {
  const current = get(choice);
  if (current !== undefined) return current;
  const loaded = get(stored);
  if (AsyncResult.isSuccess(loaded)) return loaded.value;
  // An unreadable grant is no grant; staying undefined would also block on-device voice input.
  return AsyncResult.isFailure(loaded) ? null : undefined;
}).pipe(Atom.keepAlive);

export function chooseVoiceEnvironment(environmentId: EnvironmentId | null) {
  appAtomRegistry.set(choice, null);
  // Two device-only stores must agree; a stale secure-store value cannot restore a revoked grant.
  const grant = storage.choose(environmentId);
  appAtomRegistry.set(choice, grant);
}
