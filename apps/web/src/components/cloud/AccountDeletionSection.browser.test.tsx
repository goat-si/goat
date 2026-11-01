import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AccountDeletionSection } from "./AccountDeletionSection";

const state = vi.hoisted(() => ({
  clerk: { user: null as object | null, session: null as object | null },
  listeners: new Set<() => void>(),
}));
vi.mock("@clerk/react", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useClerk: () => state.clerk,
    useUser: () => ({ user: useSyncExternalStore(subscribe, () => state.clerk.user) }),
    useSession: () => ({ session: useSyncExternalStore(subscribe, () => state.clerk.session) }),
    useReverification: (callback: unknown) => callback,
  };
});
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));
import { runtime } from "../../lib/runtime";

function setup() {
  const first = {
    user: { id: "account-a", delete: vi.fn() },
    session: { id: "session-a", getToken: vi.fn<() => Promise<string | null>>() },
  };
  state.clerk = { ...first };
  state.listeners.clear();
  vi.mocked(runtime.runPromise).mockReset();
  const emit = (next: typeof state.clerk) => {
    // Clerk keeps its instance while publishing new user/session resources.
    Object.assign(state.clerk, next);
    state.listeners.forEach((listener) => listener());
  };
  return { first, emit };
}

it.each(["account", "session"])("hosted consent does not carry into another %s", async (change) => {
  const { first, emit } = setup();
  await using screen = await render(<AccountDeletionSection />);
  await userEvent.click(screen.getByRole("checkbox"));
  await expect
    .element(screen.getByRole("button", { name: "Delete account / continue" }))
    .toBeEnabled();
  const next = {
    user: change === "account" ? { id: "account-b", delete: vi.fn() } : first.user,
    session: { id: "session-b", getToken: vi.fn() },
  };
  await act(() => emit(next));
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

it.each(["account", "session", "refresh", "sign-out"])(
  "%s during a pending deletion clears busy state and invalidates old consent without a rerender",
  async (change) => {
    const { first, emit } = setup();
    let resolveToken!: (value: string | null) => void;
    const token = {
      promise: new Promise<string | null>((resolve) => {
        resolveToken = resolve;
      }),
      resolve: (value: string | null) => resolveToken(value),
    };
    first.session.getToken.mockReturnValue(token.promise);
    await using screen = await render(<AccountDeletionSection />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Delete account / continue" }));
    await expect.element(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    const next = {
      user: change === "account" ? { id: "account-b", delete: vi.fn() } : first.user,
      session: {
        id: change === "refresh" ? first.session.id : "session-b",
        getToken: vi.fn(),
      },
    };
    await act(() => emit(change === "sign-out" ? { user: null, session: null } : next));
    await expect.element(screen.getByRole("button", { name: "Working…" })).not.toBeInTheDocument();
    if (change === "sign-out") {
      await expect.element(screen.getByRole("checkbox")).not.toBeInTheDocument();
    } else {
      await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
      await expect
        .element(screen.getByRole("button", { name: "Refresh deletion status" }))
        .toBeEnabled();
    }
    await act(() => emit(first));
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
    await expect
      .element(screen.getByRole("button", { name: "Refresh deletion status" }))
      .toBeEnabled();
    await act(async () => {
      token.resolve(`e30.${btoa(JSON.stringify({ sub: first.user.id }))}.fixture`);
      await token.promise;
    });
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Delete account / continue" }))
      .toBeDisabled();
    expect(runtime.runPromise).not.toHaveBeenCalled();
    expect(first.user.delete).not.toHaveBeenCalled();
    expect(next.user.delete).not.toHaveBeenCalled();
    expect(next.session.getToken).not.toHaveBeenCalled();
  },
);
