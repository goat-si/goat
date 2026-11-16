import { AuthSessionId, AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { ServerClientSessionRecord } from "~/environments/primary";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import "../../index.css";

vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));

function clientSession(
  id: string,
  label: string,
  fields: Partial<ServerClientSessionRecord> = {},
): ServerClientSessionRecord {
  return {
    sessionId: AuthSessionId.make(id),
    subject: "one-time-token",
    scopes: [...AuthStandardClientScopes],
    method: "browser-session-cookie",
    client: { label, deviceType: "desktop" },
    issuedAt: "2026-11-17T00:00:00.000Z",
    expiresAt: "2026-12-17T00:00:00.000Z",
    lastConnectedAt: null,
    connected: false,
    current: false,
    ...fields,
  };
}

const thisDevice = clientSession("current", "This browser", { current: true });
const desktop = clientSession("desktop", "GOAT Desktop", {
  subject: "desktop-bootstrap",
  method: "bearer-access-token",
  keptByRevokeOthers: "desktop",
});
const pen = clientSession("pen", "Pen member test-box", {
  subject: "pen-proxy",
  method: "bearer-access-token",
  client: { label: "Pen member test-box", deviceType: "unknown" },
  keptByRevokeOthers: "pen",
});
const phone = clientSession("phone", "Test phone", {
  client: { label: "Test phone", deviceType: "mobile" },
});

function Clients({ sessions }: { readonly sessions: ReadonlyArray<ServerClientSessionRecord> }) {
  return (
    <>
      <AuthorizedClientsHeaderAction
        onPairingLinkCreated={() => undefined}
        clientSessions={sessions}
        isRevokingOtherClients={false}
        onRevokeOtherClients={() => undefined}
        delegatableScopes={[...AuthStandardClientScopes]}
      />
      <PairingClientsList
        endpointUrl={null}
        endpoints={[]}
        defaultEndpointKey={null}
        isLoading={false}
        pairingLinks={[]}
        createdPairingCredentials={new Map()}
        sharedPairingLinkId={null}
        clientSessions={sessions}
        revokingPairingLinkId={null}
        revokingClientSessionId={null}
        onRevokePairingLink={() => undefined}
        onRevokeClientSession={() => undefined}
        canRevoke
      />
    </>
  );
}

it("Authorized clients marks the sessions Revoke others keeps, and the button is off when only those remain", async () => {
  await using screen = await render(<Clients sessions={[thisDevice, desktop, pen, phone]} />);
  const revokeOthers = screen.getByRole("button", { name: "Revoke others" });
  const badges = screen.getByText("Kept by Revoke others");
  await expect.element(badges.nth(1)).toBeVisible();
  expect(badges.elements()).toHaveLength(2);
  await expect.element(revokeOthers).toBeEnabled();

  await screen.rerender(<Clients sessions={[thisDevice, desktop, pen]} />);
  await expect.element(revokeOthers).toBeDisabled();
});
