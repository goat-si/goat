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
import "../../index.css";

type EnvironmentRow = { environmentId: EnvironmentId; label: string; entry: { enabled: boolean } };
const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  environments: null as ReadonlyArray<EnvironmentRow> | null,
}));
vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  createServerPairingCredential: mocks.createCredential,
}));
// Other settings modules in this import graph read the real session atoms.
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
  useEnvironments: () => ({ environments: mocks.environments ?? [] }),
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
  mocks.environments = null;
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
    await expect.element(dialog().getByText(/GOAT restarts to apply this/)).toBeVisible();
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
    await expect.element(dialog().getByText(/Checking network settings/)).toBeVisible();
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

it("phone QR: offers Tailscale HTTPS only while Serve is off; an unreachable Serve is explained and can be turned off", async () => {
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
    await expect.element(dialog().getByText(/Tailscale is not answering/)).toBeVisible();
    expect(dialog().getByRole("button", { name: "Turn on Tailscale HTTPS" }).query()).toBeNull();
    await dialog().getByRole("button", { name: "Done" }).click();
    // The switch follows the saved setting, so an unreachable Serve can still be turned off.
    const serveSwitch = page.getByRole("switch", { name: "Enable Tailscale HTTPS" });
    await expect.element(serveSwitch).toBeChecked();
    await serveSwitch.click();
    expect(actions.onTurnOffTailscaleHttps).toHaveBeenCalledTimes(1);
  }
  {
    // With Network access off, turning it on still gives a local network path.
    await using _screen = await render(
      <Card
        connectActions={actions}
        endpoints={[httpsUnreachable]}
        exposureState={exposure("local-only", true)}
      />,
      { router: false },
    );
    await page.getByRole("button", { name: "Show phone QR" }).click();
    await expect
      .element(dialog().getByRole("button", { name: "Turn on Network access" }))
      .toBeVisible();
  }
});

function CreateLink({
  actions,
  environmentId,
}: {
  readonly actions: ReturnType<typeof setup>;
  readonly environmentId?: EnvironmentId;
}) {
  return (
    <AuthorizedClientsHeaderAction
      {...(environmentId === undefined ? {} : { environmentId })}
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

it("Create link names the environment the link pairs with and the other environments the app shows", async () => {
  const actions = setup();
  const row = (id: string, label: string, enabled = true): EnvironmentRow => ({
    environmentId: EnvironmentId.make(id),
    label,
    entry: { enabled },
  });
  // Primary and a saved SSH runtime, an enabled one that is offline, and a disabled one.
  mocks.environments = [
    row("primary", "Desk PC"),
    row("withgame", "Withgame box"),
    row("laptop", "Old laptop"),
    row("retired", "Retired box", false),
  ];
  {
    // These renders exercise the dialog alone; nothing here navigates.
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await page.getByRole("button", { name: "Create link" }).click();
    await expect
      .element(dialog().getByText(/pair with Desk PC as an authorized client/))
      .toBeVisible();
    await expect
      .element(
        dialog().getByText(
          /also shows Withgame box and Old laptop, which this link does not pair with/,
        ),
      )
      .toBeVisible();
    expect(
      dialog()
        .getByText(/Retired box/)
        .query(),
    ).toBeNull();
  }
  {
    // The saved-environment access view passes its own environment.
    await using _screen = await render(
      <CreateLink actions={actions} environmentId={EnvironmentId.make("withgame")} />,
      { router: false },
    );
    await page.getByRole("button", { name: "Create link" }).click();
    await expect
      .element(dialog().getByText(/pair with Withgame box as an authorized/))
      .toBeVisible();
    await expect.element(dialog().getByText(/also shows Desk PC and Old laptop/)).toBeVisible();
  }
  mocks.environments = [row("primary", "Desk PC")];
  {
    // A single environment needs no second sentence.
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await page.getByRole("button", { name: "Create link" }).click();
    await expect.element(dialog().getByText(/pair with Desk PC as an authorized/)).toBeVisible();
    expect(
      dialog()
        .getByText(/also shows/)
        .query(),
    ).toBeNull();
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

const environmentRow = (id: string, label: string): EnvironmentRow => ({
  environmentId: EnvironmentId.make(id),
  label,
  entry: { enabled: true },
});

it("Create link's advice for another environment names no command and claims no permissions for it", async () => {
  const actions = setup();
  mocks.environments = [
    environmentRow("primary", "Desk PC"),
    environmentRow("withgame", "Withgame box"),
  ];
  await using _screen = await render(<CreateLink actions={actions} />, { router: false });
  await page.getByRole("button", { name: "Create link" }).click();
  await dialog().getByRole("button", { name: "Read only" }).click();
  await expect
    .element(
      dialog().getByText(
        /A link for it is created on the machine that runs it; see Manage or revoke access in the Remote access guide\./,
      ),
    )
    .toBeVisible();
  expect(
    dialog()
      .getByText(/goat (pair|auth)|--scope|Standard permissions/)
      .query(),
  ).toBeNull();
});

it("Create link keeps a long environment name and many environments inside a 390 px dialog", async () => {
  const actions = setup();
  mocks.environments = [
    environmentRow("primary", "x".repeat(80)),
    ...Array.from({ length: 12 }, (_, index) =>
      environmentRow("env-" + index, "Box " + (index + 1)),
    ),
  ];
  await page.viewport(390, 844);
  try {
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await page.getByRole("button", { name: "Create link" }).click();
    await expect
      .element(dialog().getByText(/also shows Box 1, Box 2, Box 3, and 9 more, which/))
      .toBeVisible();
    // Nothing in the dialog is wider than the dialog itself.
    const popup = dialog().element();
    expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
  } finally {
    await page.viewport(1280, 720);
  }
});

it("Create link keeps its buttons on a phone screen with very long environment names", async () => {
  const actions = setup();
  mocks.environments = [
    environmentRow("primary", "t".repeat(2000)),
    ...["a", "b", "c"].map((letter) => environmentRow("env-" + letter, letter.repeat(500))),
  ];
  await page.viewport(390, 844);
  try {
    await using _screen = await render(<CreateLink actions={actions} />, { router: false });
    await page.getByRole("button", { name: "Create link" }).click();
    await expect
      .element(dialog().getByText(/which this link does not pair with/))
      .toBeInTheDocument();
    for (const name of ["Create link", "Cancel"]) {
      const box = dialog()
        .getByRole("button", { name, exact: true })
        .element()
        .getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    }
  } finally {
    await page.viewport(1280, 720);
  }
});
