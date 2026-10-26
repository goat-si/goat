import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { managedRelaySessionAtom, setManagedRelaySession } from "@goat/client-runtime/relay";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
} from "../agent-awareness/remoteRegistration";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "relay" },
        relay: { url: "https://relay.example.test" },
      },
    },
  },
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
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

it("mounts local children without Clerk or token reads and retains persisted registration", async () => {
  const readClerkToken = vi.fn(async () => "old-token");
  setManagedRelaySession(appAtomRegistry, { accountId: "old-account", readClerkToken });
  const { CloudAuthProvider } = await import("./CloudAuthProvider");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(createElement(CloudAuthProvider, null, createElement("span", null, "Local app"))),
    );
    expect(container.textContent).toBe("Local app");
    expect(ClerkProvider).not.toHaveBeenCalled();
    expect(useAuth).not.toHaveBeenCalled();
    expect(readClerkToken).not.toHaveBeenCalled();
    expect(releaseAgentAwarenessRelayTokenProvider).toHaveBeenCalledOnce();
    expect(setAgentAwarenessRelayTokenProvider).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
