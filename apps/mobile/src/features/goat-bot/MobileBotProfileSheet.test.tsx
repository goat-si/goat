import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Modal: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    onBlur,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
    onBlur?: () => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      onBlur={onBlur}
    />
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));

import { MobileBotProfileSheet } from "./MobileBotProfileSheet";

const initial = { name: "GOAT Bot", avatar: "🐐", purpose: "" };
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function mount(
  onSubmit: (changes: object) => Promise<string | null>,
  canSubmit = true,
  mode: "edit" | "create" = "edit",
) {
  const onClose = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotProfileSheet
        mode={mode}
        initial={mode === "create" ? { name: "", avatar: null, purpose: "" } : initial}
        canSubmit={canSubmit}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ),
  );
  return { onClose };
}
const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const save = () => container.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!;
async function type(label: string, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field(label), value);
    field(label).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("saves only the changed fields and closes, and a blank name is pointed out on blur", async () => {
  const onSubmit = vi.fn(async (_changes: object) => null);
  const { onClose } = await mount(onSubmit);
  await type("Name", "  ");
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => field("Name").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(container.textContent).toContain("The bot needs a name.");
  await type("Name", "Jarvis ");
  await type("Avatar", "");
  await type("Purpose", "Watch the deploys.");
  await act(async () => save().click());
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    name: "Jarvis",
    avatar: null,
    purpose: "Watch the deploys.",
  });
  expect(onClose).toHaveBeenCalled();
});

it("opens a new bot without an error and points out the missing name only when Save is pressed", async () => {
  const onSubmit = vi.fn(async (_changes: object) => null);
  const { onClose } = await mount(onSubmit, true, "create");
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => save().click());
  expect(container.textContent).toContain("The bot needs a name.");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await type("Name", "Scout");
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => save().click());
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: null, purpose: "" });
});

it("keeps the sheet open with the reason when the save is refused", async () => {
  const { onClose } = await mount(async () => "This request is not allowed.");
  await type("Name", "Jarvis");
  await act(async () => save().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This request is not allowed.",
  );
  expect(field("Name").value).toBe("Jarvis");
  expect(onClose).not.toHaveBeenCalled();
});

it("cannot save without permission to edit the bot", async () => {
  await mount(async () => null, false);
  expect(save().disabled).toBe(true);
});
it("opens Edit with the bot's stored purpose and sends nothing when it is unchanged", async () => {
  const onSubmit = vi.fn(async (_changes: object) => null);
  const onClose = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotProfileSheet
        mode="edit"
        initial={{ name: "Scout", avatar: null, purpose: "Find sources and summarize them." }}
        canSubmit
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ),
  );
  expect(field("Purpose").value).toBe("Find sources and summarize them.");
  await act(async () => save().click());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});
