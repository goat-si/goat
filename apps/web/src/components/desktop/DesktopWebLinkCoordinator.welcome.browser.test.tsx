import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  connectPairing: vi.fn(async (_input: { pairingUrl: string }) => ({ _tag: "Success" })),
}));

// The real root renders its /welcome branch; the wizard and the app shell around it stay out.
vi.mock(import("../../environments/primary"), async (original) => ({
  ...(await original()),
  resolveInitialServerAuthGateState: async () => ({ status: "authenticated" }) as never,
}));
vi.mock("../../routes/welcome", async () => {
  const { createFileRoute } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/welcome")({ component: () => <h1>Welcome view</h1> }) };
});
vi.mock("../CommandPalette", () => ({
  CommandPalette: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../appearance/LiquidGlassBackdrop", () => ({ LiquidGlassBackdrop: () => null }));
vi.mock("../../desktop/DesktopWindowMaterialSync", () => ({
  DesktopWindowMaterialSync: () => null,
}));
vi.mock("../../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeSync: () => undefined }));
vi.mock("../CustomSnoozeDialog", () => ({ CustomSnoozeDialogHost: () => null }));
vi.mock("../chat/GuestShareControls", () => ({ GuestShareDialogHost: () => null }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: {},
  })) as never,
}));
vi.mock(import("../../connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: "connectPairing" as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options: never) =>
      command === "connectPairing"
        ? state.connectPairing
        : actual.useAtomCommand(command as never, options)) as never,
  };
});

import { routeTree } from "../../routeTree.gen";
import { resetConfirmDialogForTests } from "../../confirmDialog";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const pairingUrl = "https://vps.example.com/pair#token=ABC123";
const pairLink = `goat://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`;

it("confirms and pairs a pair link opened during first-run onboarding", async () => {
  vi.clearAllMocks();
  let deliver: ((url: string) => void) | undefined;
  await using stack = new AsyncDisposableStack();
  stack.defer(resetConfirmDialogForTests);
  stack.use(
    stubGlobal("desktopBridge", {
      getClientSettings: async () => null,
      getLocalEnvironmentEnabled: () => true,
      onMenuAction: () => () => undefined,
      webLinks: {
        onOpen: (listener: (url: string) => void) => {
          deliver = listener;
          return () => undefined;
        },
        setReady: async (ready: boolean) => {
          if (ready) deliver?.(pairLink);
        },
      },
    }),
  );
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/welcome"] }),
  });
  await router.load();
  // The test renders the real route tree itself, so the default test router stays off.
  stack.use(
    await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
      { router: false },
    ),
  );

  await expect.element(page.getByText("Welcome view")).toBeVisible();
  await expect.element(page.getByText("Add the device at https://vps.example.com?")).toBeVisible();
  expect(state.connectPairing).not.toHaveBeenCalled();

  // Without the app stylesheet the dialog's inert backdrop covers its popup, so click the button itself.
  const confirm = page.getByRole("button", { name: "Confirm" }).element() as HTMLElement;
  await act(async () => confirm.click());
  await vi.waitFor(() =>
    expect(state.connectPairing).toHaveBeenCalledExactlyOnceWith({ pairingUrl }),
  );
  expect(router.state.location.pathname).toBe("/welcome");
});
