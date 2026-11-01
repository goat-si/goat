import { migratingStorage } from "@goat/client-runtime/storage-migration";
import * as SecureStore from "expo-secure-store";

export const secureStore = migratingStorage({
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
});
