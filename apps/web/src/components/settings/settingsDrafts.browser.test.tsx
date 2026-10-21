import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  mixed: false,
  environmentId: "first",
  save: vi.fn(),
  listeners: new Set<() => void>(),
}));
// Subscribe like the real hook does, so a pushed value re-renders the field itself.
vi.mock("./useScopedSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useScopedSettings: () => useSyncExternalStore(subscribe, () => state.settings),
    useScopedSettingsMixed: () => state.mixed,
    useUpdateScopedSettings: () => state.save,
  };
});
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ targets: [{ environmentId: state.environmentId, projectId: null }] }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children, control }: { children?: ReactNode; control?: ReactNode }) => (
    <section>
      {control}
      {children}
    </section>
  ),
  SettingResetButton: () => null,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));

import { StandingInstructionsSettings } from "./StandingInstructionsSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";

// The real hook returns a new object on every change; components may memoize on it.
const setSetting = (key: string, value: unknown) => {
  state.settings = { ...state.settings, [key]: value };
  for (const listener of state.listeners) listener();
};

let root: Root;
let container: HTMLDivElement;
const fields = [
  { label: "Standing instructions", key: "standingInstructions", mode: "static", standing: true },
  { label: "Branch prefix", key: "branchNamePrefix", mode: "static", standing: false },
  {
    label: "Branch naming instructions",
    key: "branchNameInstructions",
    mode: "custom",
    standing: false,
  },
] as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  state.mixed = false;
  state.environmentId = "first";
  state.save.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(fields)("$label", (field) => {
  const render = async () => {
    setSetting("branchNamingMode", field.mode);
    await act(() =>
      root.render(
        field.standing ? (
          <StandingInstructionsSettings isProjectScope={false} />
        ) : (
          <BranchNamingSettings />
        ),
      ),
    );
    return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[aria-label="${field.label}"]`,
    )!;
  };
  const edit = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("keeps the node, focus, selection and draft across a server push, then commits the draft", async () => {
    setSetting(field.key, "initial");
    const input = await render();
    await act(() => input.focus());
    await edit(input, " local draft ");
    input.setSelectionRange(2, 6);
    setSetting(field.key, "other device");
    const updated = await render();
    expect(updated).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(" local draft ");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    await act(() => input.blur());
    expect(state.save).toHaveBeenCalledExactlyOnceWith({ [field.key]: "local draft" });
  });

  it("reflects external changes while idle and does not overwrite them after focus without edits", async () => {
    const input = await render();
    setSetting(field.key, "idle update");
    await render();
    expect(input.value).toBe("idle update");
    await act(() => input.focus());
    setSetting(field.key, "newer update");
    await render();
    await act(() => input.blur());
    expect(input.value).toBe("newer update");
    expect(state.save).not.toHaveBeenCalled();
  });

  it("discards an uncommitted draft when switching targets without saving to either target", async () => {
    const input = await render();
    await act(() => input.focus());
    await edit(input, "old target draft");
    state.environmentId = "second";
    setSetting(field.key, "second target");
    const replacement = await render();
    expect(replacement).not.toBe(input);
    expect(replacement.value).toBe("second target");
    expect(state.save).not.toHaveBeenCalled();
  });

  if (field.standing) {
    it("preserves a draft when mixed values become equal and allows clearing mixed values", async () => {
      state.mixed = true;
      const input = await render();
      await act(() => input.focus());
      await edit(input, "draft");
      state.mixed = false;
      setSetting(field.key, "remote");
      expect(await render()).toBe(input);
      expect(input.value).toBe("draft");
      state.mixed = true;
      await render();
      await edit(input, "");
      await act(() => input.blur());
      expect(state.save).toHaveBeenCalledExactlyOnceWith({ [field.key]: "" });
    });
  }

  it(
    field.standing || field.mode === "custom"
      ? "keeps Enter available for multiline editing"
      : "commits on Enter",
    async () => {
      const input = await render();
      await act(() => input.focus());
      await edit(input, "draft");
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      await act(() => {
        input.dispatchEvent(event);
      });
      if (field.standing || field.mode === "custom") {
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(state.save).not.toHaveBeenCalled();
      } else {
        expect(state.save).toHaveBeenCalledExactlyOnceWith({ [field.key]: "draft" });
      }
    },
  );
});
