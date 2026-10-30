import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { ComponentProps, ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AuthorizedClientsHeaderAction } from "./AuthorizedClientsSettings";
import { ConnectFlowResumeCoordinator } from "./ConnectFlowResumeCoordinator";
import {
  armConnectFlowResume,
  cancelConnectFlowResume,
  peekConnectFlowResume,
  requestConnectFlowResume,
} from "./connectFlowResume";
import { HubDeviceCard } from "./HubDeviceCard";
import { pairingLinkConnectFlow } from "./PairingLinkConnectFlow";

const mocks = vi.hoisted(() => ({ createCredential: vi.fn() }));
vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: mocks.createCredential,
  isLoopbackHostname: (host: string) => host === "localhost" || host.startsWith("127."),
}));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
// The production layout subscribes to settings search state this flow does not use.
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ description, control }: { description: ReactNode; control?: ReactNode }) => (
    <div>
      <div>{description}</div>
      {control}
    </div>
  ),
}));
vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: ({ value }: { value: string }) => <output aria-label="Phone QR">{value}</output>,
}));

// The confirm in Connections arms the note; the relaunched renderer is a different load.
const PREVIOUS_LOAD = "previous-renderer-load";

const https: AdvertisedEndpoint = {
  id: "tailscale-magicdns:https://hub.tail.ts.net/",
  label: "Tailscale HTTPS",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
  httpBaseUrl: "https://hub.tail.ts.net/",
  wsBaseUrl: "wss://hub.tail.ts.net/",
  reachability: "private-network",
  status: "available",
  source: "desktop-addon",
  compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
};
const httpsUnreachable: AdvertisedEndpoint = { ...https, status: "unavailable" };

function exposure(
  mode: DesktopServerExposureState["mode"],
  tailscaleServeEnabled = false,
): DesktopServerExposureState {
  return {
    mode,
    endpointUrl: null,
    advertisedHost: null,
    tailscaleServeEnabled,
    tailscaleServePort: 443,
  };
}

function setup() {
  cancelConnectFlowResume();
  mocks.createCredential.mockReset().mockResolvedValue({
    id: "phone-link",
    credential: "PHONE1234",
    expiresAt: DateTime.makeUnsafe(Date.UTC(2099, 0, 1)),
  });
  return {
    onTurnOnNetworkAccess: vi.fn(),
    onTurnOnTailscaleHttps: vi.fn(),
    onTurnOffTailscaleHttps: vi.fn(),
  };
}

function Card(
  props: Partial<ComponentProps<typeof HubDeviceCard>> & {
    readonly connectActions: ComponentProps<typeof HubDeviceCard>["connectActions"];
  },
) {
  return (
    <HubDeviceCard
      primaryEnvironmentId={EnvironmentId.make("primary")}
      isDesktop
      canWriteAccess
      canManageLocalBackend
      delegatableScopes={[...AuthStandardClientScopes]}
      endpoints={[]}
      exposureState={exposure("local-only")}
      isNetworkAccessPending={false}
      networkAccessError={null}
      onPairingLinkCreated={() => undefined}
      {...props}
    />
  );
}

const dialog = () => page.getByRole("dialog");

it("phone QR: turning on Network access reopens the QR dialog once, only after a relaunch", async () => {
  const actions = setup();
  {
    await using _screen = await render(<Card connectActions={actions} />, { router: false });
    await page.getByRole("button", { name: "Show phone QR" }).click();
    await expect.element(dialog().getByText("GOAT restarts to apply this")).toBeVisible();
    await dialog().getByRole("button", { name: "Turn on Network access" }).click();
    expect(actions.onTurnOnNetworkAccess).toHaveBeenCalledTimes(1);
    await expect.element(dialog()).not.toBeInTheDocument();
    // The bridge accepted the change but this renderer is still the one that asked.
    armConnectFlowResume();
  }
  {
    await using _screen = await render(<Card connectActions={actions} />, { router: false });
    await expect.element(page.getByRole("button", { name: "Show phone QR" })).toBeVisible();
    expect(dialog().query()).toBeNull();
  }

  requestConnectFlowResume("phone-qr");
  armConnectFlowResume(undefined, PREVIOUS_LOAD);
  {
    await using screen = await render(
      <Card connectActions={actions} exposureState={null} isNetworkAccessPending />,
      { router: false },
    );
    await expect.element(dialog().getByText("Checking network settings")).toBeVisible();
    await screen.rerender(
      <Card
        connectActions={actions}
        endpoints={[https]}
        exposureState={exposure("network-accessible", true)}
      />,
    );
    await dialog().getByRole("button", { name: "Create phone QR" }).click();
    await expect.element(page.getByLabelText("Phone QR")).toBeVisible();
    await dialog().getByRole("button", { name: "Done" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
  }
  {
    await using _screen = await render(<Card connectActions={actions} endpoints={[https]} />, {
      router: false,
    });
    await expect.element(page.getByRole("button", { name: "Show phone QR" })).toBeVisible();
    expect(dialog().query()).toBeNull();
  }
});

it("phone QR: offers Tailscale HTTPS only while Serve is off, and explains an unreachable Serve", async () => {
  const actions = setup();
  {
    await using _screen = await render(
      <Card
        connectActions={actions}
        endpoints={[httpsUnreachable]}
        exposureState={exposure("network-accessible")}
      />,
      { router: false },
    );
    await page.getByRole("button", { name: "Show phone QR" }).click();
    await dialog().getByRole("button", { name: "Turn on Tailscale HTTPS" }).click();
    expect(actions.onTurnOnTailscaleHttps).toHaveBeenCalledWith(httpsUnreachable);
  }
  {
    await using _screen = await render(
      <Card
        connectActions={actions}
        endpoints={[httpsUnreachable]}
        exposureState={exposure("network-accessible", true)}
      />,
      { router: false },
    );
    await page.getByRole("button", { name: "Show phone QR" }).click();
    await expect.element(dialog().getByText("Tailscale is not answering")).toBeVisible();
    expect(dialog().getByRole("button", { name: "Turn on Tailscale HTTPS" }).query()).toBeNull();
  }
});

function CreateLink({ actions }: { readonly actions: ReturnType<typeof setup> }) {
  return (
    <AuthorizedClientsHeaderAction
      onPairingLinkCreated={() => undefined}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => undefined}
      delegatableScopes={[...AuthStandardClientScopes]}
      connectFlow={pairingLinkConnectFlow.slot({
        state: exposure("local-only"),
        tailscaleHttpsEndpoint: null,
        disabled: false,
        actions,
      })}
    />
  );
}

it("Create link: offers Network access in the dialog and reopens it after a relaunch until closed", async () => {
  const actions = setup();
  {
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await page.getByRole("button", { name: "Create link" }).click();
    await dialog().getByRole("button", { name: "Turn on Network access" }).click();
    expect(actions.onTurnOnNetworkAccess).toHaveBeenCalledTimes(1);
    await expect.element(dialog()).not.toBeInTheDocument();
  }
  requestConnectFlowResume("pairing-link");
  armConnectFlowResume(undefined, PREVIOUS_LOAD);
  {
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await expect.element(dialog().getByText("Create pairing link")).toBeVisible();
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
  }
  {
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await expect.element(page.getByRole("button", { name: "Create link" })).toBeVisible();
    expect(dialog().query()).toBeNull();
  }
});

it("returns a relaunched app to the Connections section of the flow it left", async () => {
  setup();
  requestConnectFlowResume("pairing-link");
  armConnectFlowResume(undefined, PREVIOUS_LOAD);
  {
    await using screen = await render(<ConnectFlowResumeCoordinator />);
    await vi.waitFor(() =>
      expect(screen.router?.state.location.href).toBe("/settings/connections#authorized-clients"),
    );
    // The Create link dialog consumes this note when it reopens.
    expect(peekConnectFlowResume()).toBe("pairing-link");
  }
  armConnectFlowResume(undefined, PREVIOUS_LOAD);
  {
    await using screen = await render(<ConnectFlowResumeCoordinator />);
    await vi.waitFor(() =>
      expect(screen.router?.state.location.href).toBe(
        "/settings/connections#connections-environment",
      ),
    );
    expect(peekConnectFlowResume()).toBeNull();
  }
});
