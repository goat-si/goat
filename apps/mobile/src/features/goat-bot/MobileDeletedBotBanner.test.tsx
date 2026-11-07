import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canManage: true,
  restore: vi.fn(async (_bot: unknown) => true),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { MobileDeletedBotBanner } from "./MobileDeletedBotBanner";

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "thread-scout",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  state: "deleted",
});

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileDeletedBotBanner
        member={scout}
        onRestore={state.canManage ? () => state.restore(scout) : undefined}
      />,
    ),
  );
  const restore = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Restore");
  return { container, root, restore };
}

it("says the member was deleted and restores it from the banner", async () => {
  state.canManage = true;
  state.restore.mockClear();
  const { container, root, restore } = await mount();
  expect(container.textContent).toContain("Scout was deleted");
  expect(container.textContent).toContain(
    "Its conversation is archived. Restore it to keep chatting here.",
  );
  await act(async () => restore()?.click());
  expect(state.restore).toHaveBeenCalledExactlyOnceWith(scout);
  await act(async () => root.unmount());
});

it("lets the person try again after a restore fails", async () => {
  state.canManage = true;
  state.restore.mockClear();
  state.restore.mockResolvedValueOnce(false);
  const { root, restore } = await mount();
  await act(async () => restore()?.click());
  expect(restore()?.disabled).toBe(false);
  await act(async () => restore()?.click());
  expect(state.restore).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it("offers no Restore to someone who cannot manage bots", async () => {
  state.canManage = false;
  const { container, root, restore } = await mount();
  expect(container.textContent).toContain("Scout was deleted");
  expect(restore()).toBeUndefined();
  await act(async () => root.unmount());
});
