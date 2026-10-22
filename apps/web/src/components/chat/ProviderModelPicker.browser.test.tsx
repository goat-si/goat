import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const addProvider = vi.hoisted(() => ({
  canManage: true,
  // Set by the harness so the stand-in dialog can publish the snapshot the server would.
  publish: (_instanceId: string) => {},
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((environmentId: string | null, scope: string) =>
    environmentId !== null && scope === "providers:manage" && addProvider.canManage) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((environmentId: string | null) =>
    environmentId ? { label: "Studio Mac" } : null) as never,
}));
// The wizard talks to the environment over RPC; this stand-in finishes setup the way it reports back.
vi.mock(import("../settings/AddProviderInstanceDialog"), () => ({
  AddProviderInstanceDialog: ((props: {
    environmentLabel: string;
    onOpenChange: (open: boolean) => void;
    onFinished?: (result: { instanceId: ProviderInstanceId; signedIn: boolean }) => void;
  }) => (
    <div role="dialog" aria-label="Add provider">
      {props.environmentLabel}
      <button
        type="button"
        onClick={() => {
          addProvider.publish("claude_new");
          props.onFinished?.({ instanceId: ProviderInstanceId.make("claude_new"), signedIn: true });
          props.onOpenChange(false);
        }}
      >
        Finish setup
      </button>
      <button type="button" onClick={() => props.onOpenChange(false)}>
        Close setup
      </button>
    </div>
  )) as never,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

import { act, render } from "../../../test/render";

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({ favorites: [], providerModelPreferences: {} }),
  useToggleEnvironmentModelFavorite: () => async () => {},
}));

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

describe("ProviderModelPicker add provider", () => {
  const environmentId = EnvironmentId.make("studio");
  const codex = providerEntry("codex", "codex");
  const models = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
    [codex.instanceId, [{ slug: "gpt-5", name: "GPT 5" }]],
    [ProviderInstanceId.make("claude_new"), [{ slug: "opus", name: "Claude Opus" }]],
  ]);

  function Harness(props: { composer?: boolean }) {
    const [entries, setEntries] = useState([codex, providerEntry("cursor", "cursor")]);
    useEffect(() => {
      addProvider.publish = (instanceId) =>
        setEntries((current) => [...current, providerEntry(instanceId, "claudeAgent")]);
    }, []);
    return (
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={codex.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={models}
        isComposerOwned={props.composer ?? true}
        onInstanceModelChange={() => {}}
      />
    );
  }

  function setup(canManage = true) {
    addProvider.canManage = canManage;
    addProvider.publish = () => {};
  }
  async function openPicker(node: ReactNode) {
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await render(node));
    await userEvent.click(screen.container.querySelector("button")!);
    const owned = stack.move();
    return { screen, [Symbol.asyncDispose]: () => owned[Symbol.asyncDispose]() };
  }
  const addButton = () =>
    document.querySelector<HTMLButtonElement>("[data-model-picker-add-provider] button");
  const railButton = (label: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-model-picker-sidebar] button[aria-label="${label}"]`,
    );
  const clickText = (label: string) =>
    act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === label)!
        .click(),
    );
  const setupDialog = () => document.querySelector('[role="dialog"][aria-label="Add provider"]');
  // The wizard is code-split, so the first open waits for its chunk.
  const openSetup = async () => {
    await act(async () => addButton()!.click());
    await expect.element(page.getByRole("dialog", { name: "Add provider" })).toBeVisible();
  };

  it("ends the rail with Add provider, reachable with the arrow keys", async () => {
    setup();
    await using _screen = await openPicker(<Harness />);

    expect(addButton()?.getAttribute("aria-label")).toBe("Add provider");
    railButton("Cursor")!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(addButton());
  });

  it("explains why it is unavailable without providers:manage", async () => {
    setup(false);
    await using _screen = await openPicker(<Harness />);

    expect(addButton()?.getAttribute("aria-label")).toBe(
      "You don't have permission to manage providers on Studio Mac.",
    );
    await act(async () => addButton()!.click());
    expect(setupDialog()).toBeNull();
  });

  it("is not offered outside the composer", async () => {
    setup();
    await using _screen = await openPicker(<Harness composer={false} />);

    expect(railButton("Codex")).not.toBeNull();
    expect(addButton()).toBeNull();
  });

  it("opens setup and returns to the picker on the new provider with its models", async () => {
    setup();
    await using _screen = await openPicker(<Harness />);
    await openSetup();

    expect(setupDialog()?.textContent).toContain("Studio Mac");
    await expect.element(page.getByRole("toolbar", { name: "Providers" })).not.toBeInTheDocument();

    await clickText("Finish setup");
    await expect
      .element(page.getByRole("button", { name: "Claude New", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // The model list is virtualized and fills in after it measures.
    await expect.element(page.getByRole("option", { name: /Claude Opus/ })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /GPT 5/ })).not.toBeInTheDocument();
  });

  it("returns to the picker when setup is closed", async () => {
    setup();
    await using _screen = await openPicker(<Harness />);
    await openSetup();
    await clickText("Close setup");

    await expect
      .element(page.getByRole("button", { name: "Codex", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });
});
