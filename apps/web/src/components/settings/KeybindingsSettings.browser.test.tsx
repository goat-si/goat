import ko from "../../i18n/translations/ko.json";
import { GTProvider } from "gt-react";
import { initializeI18n } from "../../i18n/initializeI18n";
import chinese from "../../i18n/translations/zh.json";
import { RegistryProvider } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: { keybindings: [], keybindingsConfigPath: null, availableEditors: [] },
    };
    return {
      scope: { kind: "environment" },
      environment,
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));

import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

// The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
async function activate(locator: Locator, action: "click" | "focus") {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement)[action]();
}

const existingField = page.getByRole("textbox", { name: "Keybinding for Sidebar: Toggle" });
const existingPill = page.getByRole("button", { name: /^Edit shortcut for Sidebar: Toggle:/ });
const newField = page.getByRole("textbox", { name: "Keybinding for new keybinding" });

describe("Esc in a shortcut recorder", () => {
  it.each<{
    name: string;
    field: Locator;
    open: () => Promise<void>;
    expectReset: () => Promise<void>;
  }>([
    {
      name: "existing binding",
      field: existingField,
      open: () => activate(existingPill, "click"),
      expectReset: async () => {
        await expect.element(existingField).not.toBeInTheDocument();
        await expect.element(existingPill).toHaveFocus();
        await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
      },
    },
    {
      name: "new binding",
      field: newField,
      open: async () => {
        await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
        await activate(newField, "focus");
      },
      expectReset: async () => {
        await expect.element(newField).toHaveValue("");
        await expect.element(newField).toHaveAttribute("placeholder", "Unassigned");
      },
    },
  ])("leaves the $name field without closing Settings", async ({ field, open, expectReset }) => {
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          <KeybindingsSettingsPanel />
        </DialogPopup>
      </Dialog>,
    );

    await open();
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(field).not.toHaveValue("");
    await userEvent.tab();
    await activate(field, "focus");
    await expect.element(field).toHaveAttribute("placeholder", "Press shortcut");

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement?.matches("[data-keybinding-capture]")).toBe(false);
    await expectReset();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it.each([
    { name: "existing binding", field: existingField, open: () => activate(existingPill, "click") },
    {
      name: "new binding",
      field: newField,
      open: async () => {
        await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
        await activate(newField, "focus");
      },
    },
  ])("records Shift+Esc in the $name field", async ({ field, open }) => {
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          <KeybindingsSettingsPanel />
        </DialogPopup>
      </Dialog>,
    );

    await open();
    await userEvent.keyboard("{Shift>}{Escape}{/Shift}");

    await expect.element(field).toHaveValue("shift+esc");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

it("Esc in the keybindings search clears the query without closing Settings", async () => {
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogTitle>Settings</DialogTitle>
        <KeybindingsSettingsPanel />
      </DialogPopup>
    </Dialog>,
  );
  const search = page.getByRole("searchbox", { name: "Search keybindings" });
  await search.fill("sidebar");

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();

  await act(() =>
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  expect(onOpenChange).not.toHaveBeenCalled();

  await search.fill("sidebar");
  await userEvent.keyboard("{Shift>}{Escape}{/Shift}");
  await expect.element(search).toHaveValue("sidebar");
  await expect.element(search).toHaveFocus();
  expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
});

it("re-enables Save when a When editor closes on an expression it could not parse", async () => {
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
  );
  const whenTrigger = screen.getByRole("button", { name: "Edit when clause for Terminal: Toggle" });
  const expression = screen.getByRole("textbox", { name: "When expression" });

  await whenTrigger.click();
  await userEvent.type(expression, "terminalFocus");
  await userEvent.type(expression, " &&");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  await whenTrigger.click();

  await expect.element(expression).toHaveValue("terminalFocus");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("filters actions and allows additional shortcuts for assigned commands", async () => {
  await using screen = await render(<KeybindingsSettingsPanel />);
  await screen.getByRole("button", { name: "Add keybinding" }).click();
  const dialog = page.getByRole("dialog", { name: "Command", exact: true });
  const search = dialog.getByRole("combobox", { name: "Search", exact: true });
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("sidebar.toggle");
  const assigned = page.getByRole("option", { name: /^Sidebar: Toggle(?! Activity)/ });
  await expect.element(assigned).not.toHaveAttribute("aria-disabled", "true");
  await expect.element(assigned.element().querySelector("kbd")!).toBeVisible();
  await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(2));
  await assigned.click();
  const command = screen.getByRole("combobox", { name: "Command", exact: true });
  await expect.element(command).toHaveTextContent("Sidebar: Toggle");
  await command.click();
  await search.fill("Opposite Queue");
  await expect
    .element(page.getByRole("option", { name: /Composer: Opposite Queue or Steer Action/ }))
    .toBeVisible();
  await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
  await search.fill("no-such-action");
  await expect.element(page.getByText("No results found.")).toBeVisible();
  await search.fill("composer.cycleHost");
  const available = page.getByRole("option", { name: "Composer: Cycle Host" });
  await expect.element(available).not.toHaveAttribute("aria-disabled", "true");
  await available.click();
  await expect
    .element(screen.getByRole("combobox", { name: "Command", exact: true }))
    .toHaveTextContent("Composer: Cycle Host");
});

it("finds a localized shortcut by its display name, English label, or command ID", async () => {
  using _locale = {
    [Symbol.dispose]() {
      initializeI18n(() => {});
    },
  };
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh: chinese }}>
      <KeybindingsSettingsPanel />
    </GTProvider>,
  );
  const search = screen.getByRole("searchbox", { name: "搜索快捷键" });
  for (const query of ["切换命令面板", "Command Palette: Toggle", "commandPalette.toggle"]) {
    await search.fill(query);
    await expect.element(screen.getByText("切换命令面板", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("打开首选编辑器", { exact: true }))
      .not.toBeInTheDocument();
  }
  await search.fill("复制路径");
  await expect.element(screen.getByText("文件：复制路径", { exact: true })).toBeVisible();
  await screen
    .getByRole("button", { name: /文件：复制路径/ })
    .filter({ hasText: "fileViewFocus" })
    .click();
  await expect
    .element(page.getByRole("button", { name: "条件组", exact: true }).first())
    .toBeVisible();
});

it("announces shortcut and condition controls in Korean", async () => {
  using _locale = {
    [Symbol.dispose]() {
      initializeI18n(() => {});
    },
  };
  await using screen = await render(
    <GTProvider locale="ko" translations={{ ko }}>
      <KeybindingsSettingsPanel />
    </GTProvider>,
  );
  const command = "명령 팔레트 표시 전환";
  await expect.element(screen.getByRole("button", { name: `조건 편집: ${command}` })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: `작업: ${command}` }))
    .toBeInTheDocument();
  const shortcut = screen.getByRole("button", { name: new RegExp(`^단축키 편집: ${command}:`) });
  await expect.element(shortcut).toBeVisible();
  await shortcut.click();
  await expect.element(screen.getByRole("textbox", { name: `단축키: ${command}` })).toBeVisible();
});

it("keeps the keybindings search query when an IME Escape cancels a conversion", async () => {
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <RegistryProvider>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          <KeybindingsSettingsPanel />
        </DialogPopup>
      </Dialog>
    </RegistryProvider>,
  );
  const search = page.getByRole("searchbox", { name: "Search keybindings" });
  await search.fill("sidebar");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    const keydown = new KeyboardEvent("keydown", {
      ...composition,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      // Safari ends the composition just before the Escape keydown.
      if (!composition.isComposing)
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search.element().dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(false);
    await expect.element(search).toHaveValue("sidebar");
    await expect.element(search).toHaveFocus();
  }
  expect(search.element().getAttribute("type")).toBe("text");

  await userEvent.keyboard("{Escape}");

  await expect.element(search).toHaveValue("");
  expect(onOpenChange).not.toHaveBeenCalled();
});

it.each([
  {
    name: "macOS",
    platform: "MacIntel",
    newChat: {
      ariaLabel: "Edit shortcut for Chat: New: ⇧⌘O",
      keys: ["⇧", "⌘", "O"],
    },
    editQueued: {
      ariaLabel: "Edit shortcut for Queue: Edit Last Queued Message: ⌥Up",
      keys: ["⌥", "Up"],
    },
    focusNext: { ariaLabel: "Edit shortcut for Focus Next Workspace Area: F6", keys: ["F6"] },
  },
  {
    name: "Linux",
    platform: "Linux x86_64",
    newChat: {
      ariaLabel: "Edit shortcut for Chat: New: Ctrl+Shift+O",
      keys: ["Ctrl", "Shift", "O"],
    },
    editQueued: {
      ariaLabel: "Edit shortcut for Queue: Edit Last Queued Message: Alt+Up",
      keys: ["Alt", "Up"],
    },
    focusNext: { ariaLabel: "Edit shortcut for Focus Next Workspace Area: F6", keys: ["F6"] },
  },
])(
  "renders platform modifier symbols and formatted key labels in shortcut pills on $name",
  async ({ platform, newChat, editQueued, focusNext }) => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await using screen = await render(<KeybindingsSettingsPanel />);

    for (const expected of [newChat, editQueued, focusNext]) {
      const button = screen.getByRole("button", { name: expected.ariaLabel, exact: true });
      await expect.element(button).toBeVisible();
      const kbdTexts = Array.from(
        button.element().querySelectorAll('[data-slot="kbd"]'),
        (el) => el.textContent,
      );
      expect(kbdTexts).toEqual(expected.keys);
    }
  },
);
