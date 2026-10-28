import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AccountDeletionSection } from "./AccountDeletionSection";
import * as Dialog from "../../components/ui/Dialog";

const state = vi.hoisted(() => ({
  clerk: { user: null as object | null, session: null as object | null },
  listeners: new Set<() => void>(),
}));
vi.mock("@clerk/expo", async () => {
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
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "fixture-key" }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: vi.fn() }));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));
import { runtime } from "../../lib/runtime";

function setup() {
  const first = {
    user: { id: "account-a", delete: vi.fn() },
    session: { id: "session-a", getToken: vi.fn<() => Promise<string | null>>() },
  };
  state.clerk = { ...first };
  state.listeners.clear();
  vi.mocked(Dialog.confirm).mockReset();
  vi.mocked(runtime.runPromise).mockReset();
  const emit = (next: typeof state.clerk) => {
    Object.assign(state.clerk, next);
    state.listeners.forEach((listener) => listener());
  };
  return { first, emit };
}

it.each(["account", "session"])(
  "native dialog consent cannot delete a different %s",
  async (change) => {
    const { first, emit } = setup();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => root.render(<AccountDeletionSection />));
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      await act(() => button?.click());
      const consent = vi.mocked(Dialog.confirm).mock.calls[0]?.[0];
      expect(consent).toBeDefined();
      const next = {
        user: change === "account" ? { id: "account-b", delete: vi.fn() } : first.user,
        session: { id: "session-b", getToken: vi.fn() },
      };
      await act(() => emit(next));
      await act(async () => {
        await consent?.onConfirm?.();
      });
      expect(first.session.getToken).not.toHaveBeenCalled();
      expect(next.session.getToken).not.toHaveBeenCalled();
      expect(runtime.runPromise).not.toHaveBeenCalled();
      expect(first.user.delete).not.toHaveBeenCalled();
      expect(next.user.delete).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
    }
  },
);

it.each(["account", "session", "refresh", "sign-out"])(
  "native %s during deletion recovers before the old request settles",
  async (change) => {
    const { first, emit } = setup();
    const token = Promise.withResolvers<string | null>();
    first.session.getToken.mockReturnValue(token.promise);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => root.render(<AccountDeletionSection />));
      await act(() => container.querySelector("button")?.click());
      const consent = vi.mocked(Dialog.confirm).mock.calls[0]?.[0];
      expect(consent).toBeDefined();
      await act(async () => {
        await consent?.onConfirm?.();
      });
      expect(container.textContent).toContain("Working…");
      const next = {
        user: change === "account" ? { id: "account-b", delete: vi.fn() } : first.user,
        session: {
          id: change === "refresh" ? first.session.id : "session-b",
          getToken: vi.fn(),
        },
      };
      await act(() => emit(change === "sign-out" ? { user: null, session: null } : next));
      expect(container.textContent).not.toContain("Working…");
      if (change === "sign-out") expect(container.querySelector("button")).toBeNull();
      else expect(container.querySelector("button")?.disabled).toBe(false);
      await act(() => emit(first));
      expect(container.querySelector("button")?.disabled).toBe(false);
      await act(async () => {
        await consent?.onConfirm?.();
        token.resolve(`e30.${btoa(JSON.stringify({ sub: first.user.id }))}.fixture`);
        await token.promise;
      });
      expect(first.session.getToken).toHaveBeenCalledTimes(1);
      expect(runtime.runPromise).not.toHaveBeenCalled();
      expect(first.user.delete).not.toHaveBeenCalled();
      expect(next.user.delete).not.toHaveBeenCalled();
      expect(next.session.getToken).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Working…");
      expect(container.textContent).not.toContain("Account or session changed");
    } finally {
      await act(() => root.unmount());
    }
  },
);
