import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AccountDeletionSection } from "./AccountDeletionSection";
import * as Dialog from "../../components/ui/Dialog";

const state = vi.hoisted(() => ({
  clerk: { user: null as object | null, session: null as object | null },
}));
vi.mock("@clerk/expo", () => ({
  useClerk: () => state.clerk,
  useReverification: (callback: unknown) => callback,
}));
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

it.each(["account", "session"])(
  "native dialog consent cannot delete a different %s",
  async (change) => {
    const first = {
      user: { id: "account-a", delete: vi.fn() },
      session: { id: "session-a", getToken: vi.fn() },
    };
    state.clerk = { ...first };
    vi.mocked(Dialog.confirm).mockClear();
    vi.mocked(runtime.runPromise).mockClear();
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
      // Clerk mutates the same instance before the already-presented native callback fires.
      Object.assign(state.clerk, next);
      await act(() => root.render(<AccountDeletionSection />));
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
