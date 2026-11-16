import { AuthSessionId, AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

function Clients({
  sessions,
  servedByEnvironment = true,
}: {
  readonly sessions: ReadonlyArray<ServerClientSessionRecord>;
  readonly servedByEnvironment?: boolean;
}) {
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
        servedByEnvironment={servedByEnvironment}
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

it.each([
  { servedByEnvironment: true, where: "on this computer" },
  { servedByEnvironment: false, where: "on that computer" },
])(
  "A kept desktop row explains itself to a keyboard user, naming the computer $where",
  async ({ servedByEnvironment, where }) => {
    await using screen = await render(
      <Clients sessions={[thisDevice, desktop]} servedByEnvironment={servedByEnvironment} />,
    );
    const badge = screen.getByRole("button", { name: "Kept by Revoke others" });
    badge.element().focus();
    await expect.element(badge).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(
        page.getByText(
          `Signed in with the desktop app's built-in credential, normally the GOAT desktop app ${where}. If you do not recognise it or suspect it, revoke it by itself`,
          { exact: false },
        ),
      )
      .toBeVisible();
  },
);

it("A kept Pen row explains itself to a keyboard user", async () => {
  await using screen = await render(<Clients sessions={[thisDevice, pen]} />);
  const badge = screen.getByRole("button", { name: "Kept by Revoke others" });
  badge.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByText("A Pen member holds this session", { exact: false }))
    .toBeVisible();
});

it("This device's own row has no Kept mark even when it is a kept kind", async () => {
  await using screen = await render(<Clients sessions={[{ ...desktop, current: true }, phone]} />);
  await expect.element(screen.getByText("This device")).toBeVisible();
  expect(screen.getByText("Kept by Revoke others").elements()).toHaveLength(0);
});

it("What Revoke others keeps is reachable from the keyboard while the button is off", async () => {
  await using screen = await render(<Clients sessions={[thisDevice, desktop, pen]} />);
  await expect.element(screen.getByRole("button", { name: "Revoke others" })).toBeDisabled();
  const explain = screen.getByRole("button", { name: "What Revoke others keeps" });
  explain.element().focus();
  await expect.element(explain).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      page.getByText(
        "Revoke others ends every other client except sessions signed in with the desktop app's built-in credential and Pen members' sessions.",
        { exact: false },
      ),
    )
    .toBeVisible();
});
