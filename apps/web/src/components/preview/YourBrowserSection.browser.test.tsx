import { EnvironmentId, ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { YourBrowserSection } from "./YourBrowserSection";

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  end: vi.fn(),
  revoke: vi.fn(),
  allowed: true,
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    claimChanges: () => null,
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
  title: "Example window",
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
  mocks.snapshot = snapshot;
  mocks.allowed = allowed;
  mocks.end.mockReset();
  mocks.revoke.mockReset();
}

it("hides unavailable and empty browser claims", async () => {
  setup(null);
  await using screen = await render(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Your browser")).not.toBeInTheDocument();
  setup({ claims: [], grants: [], pending: [] });
  await screen.rerender(<YourBrowserSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Your browser")).not.toBeInTheDocument();
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
  await expect.element(screen.getByText("Your browser")).not.toBeInTheDocument();
});
