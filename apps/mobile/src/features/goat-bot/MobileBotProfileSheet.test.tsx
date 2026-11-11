import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
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
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState?.expanded}
    >
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
  children?: ReactNode,
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
      >
        {children}
      </MobileBotProfileSheet>,
    ),
  );
  return { onClose };
}
const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const save = () => container.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!;
const create = () => container.querySelector<HTMLButtonElement>('button[aria-label="Create"]')!;
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

it("opens a new bot without an error and points out the missing name only when Create is pressed", async () => {
  const onSubmit = vi.fn(async (_changes: object) => null);
  const { onClose } = await mount(onSubmit, true, "create");
  expect(container.textContent).not.toContain("The bot needs a name.");
  // Leaving the untouched name, say to open More, is not a mistake yet.
  await act(async () => field("Name").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => create().click());
  expect(container.textContent).toContain("The bot needs a name.");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await type("Name", "Scout");
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => create().click());
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: null, purpose: "" });
});

it("points out a new bot's name the person typed and then cleared, once they leave the field", async () => {
  await mount(
    vi.fn(async (_changes: object) => null),
    true,
    "create",
  );
  await type("Name", "Sc");
  await type("Name", "");
  expect(container.textContent).not.toContain("The bot needs a name.");
  await act(async () => field("Name").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(container.textContent).toContain("The bot needs a name.");
});

it("asks a new bot only for a name and a look; its purpose and model wait under More", async () => {
  await mount(async () => null, true, "create", <p>model picker</p>);
  expect(field("Name")).not.toBeNull();
  expect(field("Avatar")).not.toBeNull();
  expect(field("Purpose")).toBeNull();
  expect(container.textContent).not.toContain("model picker");
  const more = container.querySelector<HTMLButtonElement>('button[aria-label="More"]')!;
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await act(async () => more.click());
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(field("Purpose")).not.toBeNull();
  expect(container.textContent).toContain("model picker");
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

it("says Creating… to a screen reader while a new bot is being created", async () => {
  const pending = Promise.withResolvers<string | null>();
  await mount(() => pending.promise, true, "create");
  await type("Name", "Scout");
  await act(async () => create().click());
  expect(container.querySelector('button[aria-label="Creating…"]')).not.toBeNull();
  await act(async () => pending.resolve(null));
});
