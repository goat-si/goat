import { describe, expect, it, vi } from "vite-plus/test";
import { runConnectSensitiveAction } from "@goat/client-runtime/relay";
import type { ConnectAuthorizeRequest } from "@goat/shared/connectAuth";
import { render } from "../../../test/render";
import { ConnectCliAuthorizeSurface } from "./ConnectCliAuthSurface";

const state = vi.hoisted(() => ({
  request: null as ConnectAuthorizeRequest | null,
  navigate: vi.fn(),
  token: vi.fn<() => Promise<string | null>>(),
  reverify: vi.fn<() => Promise<void>>(),
  invalidate: vi.fn<() => Promise<void>>(),
}));
vi.mock("@clerk/react", async (original) => ({
  ...(await original<typeof import("@clerk/react")>()),
  useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: state.token }),
  useClerk: () => ({
    user: { primaryEmailAddress: { emailAddress: "operator@example.test" } },
    openSignIn: vi.fn(),
  }),
}));
vi.mock("@goat/shared/connectAuth", async (original) => ({
  ...(await original<typeof import("@goat/shared/connectAuth")>()),
  readConnectAuthorizeRequest: () => state.request,
}));
vi.mock("../../cloud/connectCliAuth", async (original) => ({
  ...(await original<typeof import("../../cloud/connectCliAuth")>()),
  navigateConnectCliToOAuth: state.navigate,
  connectCliSignInRedirectUrl: (_request: unknown, href: string) => href,
}));
vi.mock("../../cloud/publicConfig", async (original) => ({
  ...(await original<typeof import("../../cloud/publicConfig")>()),
  resolveRelayClerkTokenOptions: () => ({ skipCache: true }),
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.test" }),
}));
vi.mock("../../cloud/useConnectReverification", () => ({
  useConnectReverification: () => state.reverify,
  useConnectSensitiveAction:
    () =>
    <A,>(action: () => Promise<A>) =>
      runConnectSensitiveAction({ action, reverify: state.reverify, invalidate: state.invalidate }),
}));

function setup() {
  state.navigate.mockReset();
  state.reverify.mockReset().mockResolvedValue(undefined);
  state.invalidate.mockReset().mockResolvedValue(undefined);
  state.token.mockReset().mockResolvedValue("fresh-session");
  state.request = {
    state: "s".repeat(22),
    challenge: "c".repeat(43),
    loopbackPort: 34338,
    approval: {
      state: "s".repeat(22),
      approvalChallenge: "v".repeat(43),
      cliKeyThumbprint: "cli-key",
      intent: {
        connectAuthPolicyVersion: 1,
        environmentId: "host-1",
        environmentPublicKey: "host-key",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: true,
      },
    },
  };
}

describe("hosted CLI approval", () => {
  it("delivers approval in a loopback POST before navigating to OAuth", async () => {
    setup();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    await using screen = await render(<ConnectCliAuthorizeSurface />, { router: "/connect" });
    using fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? Response.json({ approval: "signed-approval", expiresAt: "2030-01-01T00:00:00Z" })
        : new Response("Approved");
    });
    await expect.element(screen.getByText("Account: operator@example.test")).toBeVisible();
    await expect.element(screen.getByText("Computer: host-1")).toBeVisible();
    await screen.getByRole("button", { name: "Verify and approve" }).click();
    await vi.waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
    expect(requests.map((request) => request.url)).toEqual([
      "https://relay.example.test/v1/client/cli-link-approvals",
      "http://127.0.0.1:34338/approval",
    ]);
    expect(requests[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      approval: "signed-approval",
      state: "s".repeat(22),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("cancelling MFA after a strength denial cannot deliver approval or start OAuth", async () => {
    setup();
    state.reverify.mockRejectedValueOnce(new Error("Verification cancelled"));
    await using screen = await render(<ConnectCliAuthorizeSurface />, { router: "/connect" });
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          _tag: "RelayAuthenticationStrengthError",
          code: "authentication_strength_required",
          reason: "reauthentication_required",
          requiredLevel: "multi_factor",
          maxAgeSeconds: 600,
          traceId: "test-trace",
        },
        { status: 403 },
      ),
    );
    await screen.getByRole("button", { name: "Verify and approve" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Verification cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.invalidate).not.toHaveBeenCalled();
  });
});
