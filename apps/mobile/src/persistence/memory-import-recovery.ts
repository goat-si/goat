import { createMemoryImportRecoveryStore } from "@goat/client-runtime/memory-import-recovery";
import * as Effect from "effect/Effect";
import { make, type MobileSecureStorage } from "./mobile-secure-storage";

/** Expo SecureStore keys only admit alphanumerics, dots, dashes and underscores. */
export function memoryImportSecureKey(key: string) {
  return `memory-import.${Array.from(key, (char) => char.codePointAt(0)!.toString(16).padStart(6, "0")).join("")}`;
}

export function createMobileMemoryImportRecovery(
  storage: MobileSecureStorage["Service"] = make,
  now: () => number = Date.now,
) {
  return createMemoryImportRecoveryStore(
    {
      getItem: (key) => Effect.runPromise(storage.getItem(memoryImportSecureKey(key))),
      setItem: (key, value) =>
        Effect.runPromise(storage.setItem(memoryImportSecureKey(key), value)),
      removeItem: (key) => Effect.runPromise(storage.removeItem(memoryImportSecureKey(key))),
    },
    now,
  );
}

// All Settings mounts share one serialized store; there is no body or preview persistence.
export const mobileMemoryImportRecovery = createMobileMemoryImportRecovery();
