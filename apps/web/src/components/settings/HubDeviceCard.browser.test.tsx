import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type AdvertisedEndpoint,
  type AuthPairingCredentialResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ createCredential: vi.fn(), permitted: true }));
vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: state.createCredential,
}));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => state.permitted }));
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ id: "hub-device", title: "Connect your phone" }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    id,
    title,
    children,
  }: {
    id: string;
    title: string;
    children: ReactNode;
  }) => (
    <section id={id} tabIndex={-1}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <div>{description}</div>
      {status}
      {control}
    </div>
  ),
}));
vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: ({ value }: { value: string }) => (
    <output aria-label="Phone QR payload">{value}</output>
  ),
}));

import { HubDeviceCard } from "./HubDeviceCard";

type Props = ComponentProps<typeof HubDeviceCard>;
const onCreated = vi.fn();
let root: Root;
let props: Props;

const lan: AdvertisedEndpoint = {
  id: "desktop-lan:http://192.168.1.42:4780",
  label: "Local network",
  provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
  httpBaseUrl: "http://192.168.1.42:4780",
  wsBaseUrl: "ws://192.168.1.42:4780",
  reachability: "lan",
  status: "available",
  source: "desktop-core",
  compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
};
const https: AdvertisedEndpoint = {
  ...lan,
  id: "tailscale-magicdns:https://hub.tail.ts.net/",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
  httpBaseUrl: "https://hub.tail.ts.net/",
  wsBaseUrl: "wss://hub.tail.ts.net/",
  reachability: "private-network",
  source: "desktop-addon",
  compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
};
function created(expiresAt = Date.UTC(2099, 0, 1)): AuthPairingCredentialResult {
  return { id: "phone-link", credential: "PHONE1234", expiresAt: DateTime.makeUnsafe(expiresAt) };
}
async function render(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () => {
    root.render(<HubDeviceCard {...props} />);
  });
}
function button(name: string) {
  const match = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name || node.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}
const payload = () =>
  document.querySelector('[aria-label="Phone QR payload"]')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.permitted = true;
  state.createCredential.mockReset().mockResolvedValue(created());
  onCreated.mockReset();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    primaryEnvironmentId: EnvironmentId.make("primary"),
    isDesktop: true,
    canWriteAccess: true,
    canManageLocalBackend: true,
    delegatableScopes: [...AuthStandardClientScopes],
    endpoints: [lan, https],
    tailscaleRow: null,
    isNetworkAccessPending: false,
    networkAccessError: null,
    onPairingLinkCreated: onCreated,
  };
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

it("issues once on HTTPS open and encodes that credential in a direct GOAT app link", async () => {
  await render();
  expect(state.createCredential).not.toHaveBeenCalled();
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).toHaveBeenCalledTimes(1);
  expect(state.createCredential).toHaveBeenCalledWith({
    label: "Phone",
    scopes: [...AuthStandardClientScopes],
  });
  expect(payload()).toBe(
    "goat://pair?pairingUrl=https%3A%2F%2Fhub.tail.ts.net%2Fpair%23token%3DPHONE1234",
  );
  expect(onCreated).toHaveBeenCalledWith(
    expect.objectContaining({ id: "phone-link", credential: "PHONE1234" }),
  );
});

it("requires explicit LAN approval before issuing or showing a QR", async () => {
  await render({ endpoints: [lan] });
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).not.toHaveBeenCalled();
  expect(payload()).toBeNull();
  await act(async () => button("Use local network").click());
  expect(state.createCredential).toHaveBeenCalledTimes(1);
  expect(new URL(payload()!).searchParams.get("pairingUrl")).toBe(
    "http://192.168.1.42:4780/pair#token=PHONE1234",
  );
});

it("requires explicit tailnet approval before issuing or showing a QR", async () => {
  await render({
    endpoints: [
      {
        ...https,
        id: "tailscale-ip:http://100.84.12.7:4780",
        httpBaseUrl: "http://100.84.12.7:4780",
        wsBaseUrl: "ws://100.84.12.7:4780",
      },
    ],
  });
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).not.toHaveBeenCalled();
  await act(async () => button("Use tailnet address").click());
  expect(new URL(payload()!).searchParams.get("pairingUrl")).toBe(
    "http://100.84.12.7:4780/pair#token=PHONE1234",
  );
});

it("opens setup guidance without issuing a credential when no target exists", async () => {
  await render({ endpoints: [] });
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).not.toHaveBeenCalled();
  expect(payload()).toBeNull();
  await act(async () => button("Back to hub settings").click());
  expect(state.createCredential).not.toHaveBeenCalled();
});

it("shows request failures and allows a settled retry", async () => {
  state.createCredential.mockRejectedValueOnce(new Error("Pairing is unavailable"));
  await render();
  await act(async () => button("Show phone QR").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Pairing is unavailable");
  expect(payload()).toBeNull();
  await act(async () => button("Create phone QR").click());
  expect(state.createCredential).toHaveBeenCalledTimes(2);
  expect(payload()).not.toBeNull();
});

it("rechecks grants at execution and delegates only scopes held by this session", async () => {
  await render({ delegatableScopes: [AuthAccessWriteScope, "orchestration:read"] });
  state.permitted = false;
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).not.toHaveBeenCalled();
  state.permitted = true;
  await act(async () => button("Create phone QR").click());
  expect(state.createCredential).toHaveBeenCalledWith({
    label: "Phone",
    scopes: ["orchestration:read", AuthAccessWriteScope],
  });
});

it("prevents duplicate issuance and early close while a credential request is pending", async () => {
  let finish!: (result: AuthPairingCredentialResult) => void;
  state.createCredential.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render({ endpoints: [lan] });
  await act(async () => button("Show phone QR").click());
  const approve = button("Use local network");
  await act(async () => {
    approve.click();
    approve.click();
  });
  expect(state.createCredential).toHaveBeenCalledTimes(1);
  expect(button("Done").disabled).toBe(true);
  expect(payload()).toBeNull();
  await act(async () => finish(created()));
  expect(payload()).not.toBeNull();
});

it("suppresses a QR when its selected endpoint changes", async () => {
  await render();
  await act(async () => button("Show phone QR").click());
  expect(payload()).not.toBeNull();
  await render({ endpoints: [lan] });
  expect(payload()).toBeNull();
  expect(state.createCredential).toHaveBeenCalledTimes(1);
});

it("suppresses a QR on grant loss without issuing a replacement", async () => {
  await render();
  await act(async () => button("Show phone QR").click());
  await render({ canWriteAccess: false });
  expect(payload()).toBeNull();
  expect(state.createCredential).toHaveBeenCalledTimes(1);
});

it("disables hub QR without desktop network-settings authority", async () => {
  await render({ canManageLocalBackend: false });
  await act(async () => button("Show phone QR").click());
  expect(state.createCredential).not.toHaveBeenCalled();
  expect(payload()).toBeNull();
});

it("suppresses an issued QR during network refresh and after an inventory error", async () => {
  await render();
  await act(async () => button("Show phone QR").click());
  await render({ isNetworkAccessPending: true });
  expect(payload()).toBeNull();
  await render({ isNetworkAccessPending: false, networkAccessError: "Inventory unavailable" });
  expect(payload()).toBeNull();
  expect(state.createCredential).toHaveBeenCalledTimes(1);
});

it("does not show an expired credential as a scannable QR", async () => {
  state.createCredential.mockResolvedValue(created(Date.UTC(2026, 9, 21) - 1));
  await render();
  await act(async () => button("Show phone QR").click());
  expect(payload()).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("expired");
});

it("keeps web informational without issuing pairing credentials", async () => {
  await render({ isDesktop: false });
  expect(document.querySelectorAll("button")).toHaveLength(0);
  expect(state.createCredential).not.toHaveBeenCalled();
  expect(payload()).toBeNull();
});
