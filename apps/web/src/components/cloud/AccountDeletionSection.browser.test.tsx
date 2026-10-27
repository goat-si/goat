import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AccountDeletionSection } from "./AccountDeletionSection";

const state = vi.hoisted(() => ({
  clerk: { user: null as object | null, session: null as object | null },
}));
vi.mock("@clerk/react", () => ({
  useClerk: () => state.clerk,
  useReverification: (callback: unknown) => callback,
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));
import { runtime } from "../../lib/runtime";

it.each(["account", "session"])("hosted consent does not carry into another %s", async (change) => {
  const first = {
    user: { id: "account-a", delete: vi.fn() },
    session: { id: "session-a", getToken: vi.fn() },
  };
  state.clerk = { ...first };
  vi.mocked(runtime.runPromise).mockClear();
  await using screen = await render(<AccountDeletionSection />);
  await userEvent.click(screen.getByRole("checkbox"));
  await expect
    .element(screen.getByRole("button", { name: "Delete account / continue" }))
    .toBeEnabled();
  const next = {
    user: change === "account" ? { id: "account-b", delete: vi.fn() } : first.user,
    session: { id: "session-b", getToken: vi.fn() },
  };
  state.clerk = next;
  await screen.rerender(<AccountDeletionSection />);
  await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
  await expect
    .element(screen.getByRole("button", { name: "Delete account / continue" }))
    .toBeDisabled();
  expect(first.session.getToken).not.toHaveBeenCalled();
  expect(next.session.getToken).not.toHaveBeenCalled();
  expect(runtime.runPromise).not.toHaveBeenCalled();
  expect(first.user.delete).not.toHaveBeenCalled();
  expect(next.user.delete).not.toHaveBeenCalled();
});
