import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { managedRelaySessionAtom } from "@goat/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  CloudAuthProvider,
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
} from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

const expoConfig = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));

vi.mock("expo-constants", () => ({ default: { expoConfig } }));

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(() => null),
  useAuth: vi.fn(),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });
});

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

async function renderProvider(): Promise<void> {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(createElement(CloudAuthProvider, null, createElement("span", null, "Local app"))),
  );
  await act(() => root.unmount());
}

const completeExtra = {
  clerk: { publishableKey: "pk_test_example", jwtTemplate: "relay" },
  relay: { url: "https://relay.example.test" },
};

it("does not initialize Clerk when cloud config is incomplete even with a key and relay URL", async () => {
  expoConfig.extra = { ...completeExtra, clerk: { publishableKey: "pk_test_example" } };
  await renderProvider();
  expect(ClerkProvider).not.toHaveBeenCalled();
  expect(useAuth).not.toHaveBeenCalled();
});

it("initializes Clerk when cloud config is complete", async () => {
  expoConfig.extra = completeExtra;
  await renderProvider();
  expect(vi.mocked(ClerkProvider).mock.calls[0]?.[0]).toMatchObject({
    publishableKey: "pk_test_example",
  });
});
