import { vi } from "vite-plus/test";

vi.mock("../../i18n/I18nProvider", () => ({ useGT: () => (source: string) => source }));

// These jsdom suites load the mobile runtime without an Expo native module registry.
vi.mock("expo", () => ({
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: null },
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  randomUUID: () => globalThis.crypto.randomUUID(),
}));

vi.mock("expo-secure-store", () => ({
  isAvailableAsync: async () => false,
}));
