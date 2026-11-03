import { EnvironmentId, ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { YourBrowserSection } from "./YourBrowserSection";

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  end: vi.fn(),
  revoke: vi.fn(),
  claim: vi.fn(),
  windows: vi.fn(),
  allowed: true,
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    claimChanges: () => null,
    claim: { permissionAtom: () => Atom.make(mocks.allowed), execute: mocks.claim },
    claimWindows: { permissionAtom: () => Atom.make(mocks.allowed), execute: mocks.windows },
    claimEnd: { permissionAtom: () => Atom.make(mocks.allowed), execute: mocks.end },
    claimRevoke: { permissionAtom: () => Atom.make(mocks.allowed), execute: mocks.revoke },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.snapshot, isSuccess: mocks.snapshot !== null }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.end }) => command.execute,
}));
const environmentId = EnvironmentId.make("env:test");
const threadId = ThreadId.make("thread:test");
const threadRef = { environmentId, threadId };
const claim = {
  claimId: "claim:1",
  environmentId,
  threadId,
  tab: { pid: 1, windowId: 2, tabId: "tab" },
  title: "Tab title",
  windowTitle: "Example window",
  origin: "https://example.com",
  driverGeneration: 1,
  claimGeneration: 1,
  status: "attached" as const,
};
const grant = { environmentId, threadId, origin: "https://example.com" };
const pending = {
  claimId: "claim:2",
  threadId,
  pid: 1,
  windowId: 2,
  origin: grant.origin,
  windowTitle: "Requested",
  createdAt: 1,
};
function setup(snapshot: unknown, allowed = true) {
  mocks.snapshot =
    snapshot && typeof snapshot === "object" ? { supported: true, ...snapshot } : snapshot;
  mocks.allowed = allowed;
  mocks.end.mockReset();
  mocks.revoke.mockReset();
  mocks.claim.mockReset();
  mocks.windows.mockReset();
  mocks.windows.mockResolvedValue({
    _tag: "Success",
    value: {
      windows: [
        { pid: 1, windowId: 10, title: "First window", app: "Chrome" },
        { pid: 1, windowId: 11, title: "Second window", app: "Chrome" },
      ],
      refused: [{ pid: 2, app: "Edge", reason: "browser_process_protected" }],
    },
  });
}

it("hides unavailable browser claims and offers a picker when available", async () => {
  setup(null);
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Your browser")).not.toBeInTheDocument();
  setup({ claims: [], grants: [], pending: [] });
  await screen.rerender(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByRole("button", { name: "Let GOAT use a tab" })).toBeVisible();
});

it("shows attached claims, grants and pending requests and sends the selected actions", async () => {
  setup({ claims: [claim], grants: [grant], pending: [pending] });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Example window")).toBeVisible();
  await expect.element(screen.getByText("Agent attached")).toBeVisible();
  expect(screen.container.textContent).toContain("https://example.com");
  await expect.element(screen.getByText("Requested", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("approval card", { exact: false })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "End" }));
  expect(mocks.end).toHaveBeenCalledWith({ environmentId, input: { claimId: "claim:1" } });
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(mocks.revoke).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, origin: grant.origin },
  });
});

it("disables claim actions without permission", async () => {
  setup({ claims: [claim], grants: [grant], pending: [] }, false);
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByRole("button", { name: "End" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();
});

it("does not show claims belonging to another thread", async () => {
  const other = ThreadId.make("thread:other");
  setup({
    claims: [{ ...claim, threadId: other }],
    grants: [{ ...grant, threadId: other }],
    pending: [{ ...pending, threadId: other }],
  });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Example window")).not.toBeInTheDocument();
});

it("selects a browser window, validates the origin, and shows a refusal", async () => {
  setup({ claims: [], grants: [], pending: [] });
  mocks.claim.mockResolvedValue({
    _tag: "Success",
    value: {
      agentResult: { status: "refused" },
      personMessage: "This tab is not on https://example.com",
    },
  });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Let GOAT use a tab" }));
  await expect.element(page.getByText("First window", { exact: false })).toBeVisible();
  await expect.element(page.getByText("Second window", { exact: false })).toBeVisible();
  await expect.element(page.getByText("already has a tab", { exact: false })).toBeVisible();
  await userEvent.click(page.getByText("First window", { exact: false }));
  const origin = page.getByLabelText("Site origin");
  await userEvent.fill(origin, "https://example.com/path");
  await expect.element(page.getByRole("button", { name: "Allow" })).toBeDisabled();
  await userEvent.fill(origin, "https://example.com");
  await userEvent.click(page.getByRole("button", { name: "Allow" }));
  expect(mocks.claim).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, pid: 1, windowId: 10, origin: "https://example.com" },
  });
  await expect.element(page.getByText("This tab is not on https://example.com")).toBeVisible();
});

it("disables the picker when the person cannot grant access", async () => {
  setup({ claims: [], grants: [], pending: [] }, false);
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByRole("button", { name: "Let GOAT use a tab" })).toBeDisabled();
});

it("hides the picker when browser claims are unsupported", async () => {
  setup({ supported: false, claims: [], grants: [], pending: [] });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect
    .element(screen.getByRole("button", { name: "Let GOAT use a tab" }))
    .not.toBeInTheDocument();
});

it("closes the picker after the tab attaches", async () => {
  setup({ claims: [], grants: [], pending: [] });
  mocks.claim.mockResolvedValue({
    _tag: "Success",
    value: { agentResult: { status: "attached", claim } },
  });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Let GOAT use a tab" }));
  await userEvent.click(page.getByText("First window", { exact: false }));
  await userEvent.fill(page.getByLabelText("Site origin"), "https://example.com");
  await userEvent.click(page.getByRole("button", { name: "Allow" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("opens the browser picker when the menu action is requested", async () => {
  setup({ claims: [], grants: [], pending: [] });
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  if (!screen.router) throw new Error("Expected a router");
  const { openBrowserClaim } = await import("./browserClaimRequest");
  const { useRightPanelStore, selectActiveRightPanel } = await import("~/rightPanelStore");
  const { registerMenuAction, dispatchMenuAction } = await import("~/shortcuts/dispatcher");
  using _registration = {
    [Symbol.dispose]: registerMenuAction("browser.claim", () =>
      openBrowserClaim(threadRef, screen.router!),
    ),
  };
  dispatchMenuAction("browser.claim");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "preview",
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await screen.rerender(<YourBrowserSection threadRef={threadRef} />);
  expect(mocks.windows).toHaveBeenCalledTimes(1);
  useRightPanelStore.getState().removeThread(threadRef);
});

it("explains when the client cannot approve a browser tab", async () => {
  setup({ claims: [], grants: [], pending: [] }, false);
  await using _screen = await render(<YourBrowserSection threadRef={threadRef} />);
  const { toastManager } = await import("~/components/ui/toast");
  using toast = vi.spyOn(toastManager, "add");
  const { useBrowserClaimRequest } = await import("./browserClaimRequest");
  useBrowserClaimRequest.getState().request(threadRef);
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "This client cannot change settings to allow a browser tab.",
      }),
    ),
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("explains when browser claims are unsupported", async () => {
  setup({ supported: false, claims: [], grants: [], pending: [] });
  await using _screen = await render(<YourBrowserSection threadRef={threadRef} />);
  const { toastManager } = await import("~/components/ui/toast");
  using toast = vi.spyOn(toastManager, "add");
  const { useBrowserClaimRequest } = await import("./browserClaimRequest");
  useBrowserClaimRequest.getState().request(threadRef);
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Browser tab claims are unavailable in this environment.",
      }),
    ),
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("explains when the menu action has no active thread", async () => {
  const { openBrowserClaim } = await import("./browserClaimRequest");
  const { toastManager } = await import("~/components/ui/toast");
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await render(<div />);
  if (!screen.router) throw new Error("Expected a router");
  openBrowserClaim(null, screen.router);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Open a thread to let an agent use a browser tab.",
    }),
  );
});

it("does not reopen a pending picker after the browser panel is closed and reopened", async () => {
  setup({ claims: [], grants: [], pending: [] });
  const { openBrowserClaim } = await import("./browserClaimRequest");
  const { useRightPanelStore } = await import("~/rightPanelStore");
  await using screen = await render(<div />, { router: "/env:test/thread:test" });
  if (!screen.router) throw new Error("Expected a router");
  openBrowserClaim(threadRef, screen.router);
  useRightPanelStore.getState().close(threadRef);
  useRightPanelStore.getState().open(threadRef, "preview");
  await screen.rerender(<YourBrowserSection threadRef={threadRef} />);
  expect(mocks.windows).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  useRightPanelStore.getState().removeThread(threadRef);
});

it("does not reopen a pending picker after navigating to another thread and back", async () => {
  setup({ claims: [], grants: [], pending: [] });
  await using screen = await render(<div />, { router: "/env:test/thread:test" });
  if (!screen.router) throw new Error("Expected a router");
  const { openBrowserClaim } = await import("./browserClaimRequest");
  const { useRightPanelStore } = await import("~/rightPanelStore");
  openBrowserClaim(threadRef, screen.router);
  await screen.router.navigate({ href: "/env:test/thread:other" });
  await screen.router.navigate({ href: "/env:test/thread:test" });
  await screen.rerender(<YourBrowserSection threadRef={threadRef} />);
  expect(mocks.windows).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  useRightPanelStore.getState().removeThread(threadRef);
});
