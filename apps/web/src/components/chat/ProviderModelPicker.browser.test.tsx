import { compileResolvedKeybindingsConfig } from "@goat/shared/keybindings";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@goat/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";

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
import { TraitsPicker } from "./TraitsPicker";
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

it("announces the full current model when opening the model picker from traits", async () => {
  const openModelPicker = vi.fn();
  await using screen = await render(
    <TraitsPicker
      provider={ProviderDriverKind.make("codex")}
      model="gpt-6.1-sol"
      models={[
        {
          slug: "gpt-6.1-sol",
          name: "GPT-6.1-Sol",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
                currentValue: "high",
              },
            ],
          },
        },
      ]}
      planModeEnabled={false}
      isComposerOwned
      onModelOptionsChange={() => {}}
      onOpenModelPicker={openModelPicker}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Reasoning:/ }));
  const modelButton = page.getByRole("button", { name: "Change model, current GPT-6.1-Sol" });
  await expect.element(modelButton).toHaveTextContent("6.1 Sol");
  await userEvent.click(modelButton);
  expect(openModelPicker).toHaveBeenCalledOnce();
  await expect.element(modelButton).not.toBeInTheDocument();
});

it("persists a composer trait pick after recording its draft options", async () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("trait-test"), ThreadId.make("trait-thread"));
  const persist = vi.fn();
  await using screen = await render(
    <TraitsPicker
      provider={ProviderDriverKind.make("codex")}
      instanceId={ProviderInstanceId.make("codex")}
      threadRef={threadRef}
      onDraftModelOptionsChange={persist}
      model="gpt-6.1-sol"
      models={[
        {
          slug: "gpt-6.1-sol",
          name: "GPT-6.1-Sol",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
                currentValue: "low",
              },
            ],
          },
        },
      ]}
      planModeEnabled={false}
      isComposerOwned
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Reasoning:/ }));
  const slider = screen.getByRole("slider", { name: "Reasoning effort" });
  slider.element().focus();
  await userEvent.keyboard("{End}");
  expect(persist).toHaveBeenCalled();
  expect(
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionByProvider[
      ProviderInstanceId.make("codex")
    ]?.options,
  ).toContainEqual({ id: "reasoningEffort", value: "high" });
});

it("lets a Pi model select an advertised service tier", async () => {
  const change = vi.fn();
  await using screen = await render(
    <TraitsPicker
      provider={ProviderDriverKind.make("pi")}
      instanceId={ProviderInstanceId.make("pi")}
      model="openai/test-model"
      models={[
        {
          slug: "openai/test-model",
          name: "Test model",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "serviceTier",
                label: "Service Tier",
                type: "select",
                currentValue: "default",
                options: [
                  { id: "default", label: "Standard", isDefault: true },
                  { id: "priority", label: "Fast" },
                  { id: "ultrafast", label: "Ultrafast" },
                ],
              },
            ],
          },
        },
      ]}
      planModeEnabled={false}
      isComposerOwned
      onModelOptionsChange={change}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Reasoning:/ }));
  await userEvent.click(page.getByRole("button", { name: "Fast", exact: true }));
  expect(change).toHaveBeenCalledWith([{ id: "serviceTier", value: "priority" }]);
});

it.each([true, false])(
  "focuses the model search appropriately when coarse pointer is %s",
  async (coarse) => {
    const codex = providerEntry("codex", "codex");
    const claude = providerEntry("claudeAgent", "claudeAgent");
    const matchMedia = window.matchMedia.bind(window);
    using _pointer = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query);
      if (query === "(pointer: coarse)")
        Object.defineProperty(result, "matches", { value: coarse });
      return result;
    });

    await using screen = await render(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={codex.instanceId}
        model="codex"
        lockedProvider={null}
        instanceEntries={[codex, claude]}
        modelOptionsByInstance={
          new Map([
            [codex.instanceId, [{ slug: "codex", name: "Codex model" }]],
            [claude.instanceId, [{ slug: "opus", name: "Claude model" }]],
          ])
        }
        triggerAriaLabel="Choose model"
        onInstanceModelChange={() => {}}
      />,
    );
    await screen.getByRole("button", { name: "Choose model" }).click();
    const search = page.getByPlaceholder("Search models...");
    await expect.element(search).toBeVisible();
    const popup = search.element().closest('[data-slot="popover-popup"]');
    expect(popup).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(coarse ? popup : search.element()));

    await page.getByRole("button", { name: /^Claude/ }).click();
    await expect.element(page.getByRole("option", { name: /Claude model/ })).toBeVisible();
    if (coarse) {
      await expect.element(search).not.toHaveFocus();
      await search.click();
    }
    await expect.element(search).toHaveFocus();
  },
);

it("lists a model reported twice by one provider once, with contiguous jump shortcuts", async () => {
  const instanceId = ProviderInstanceId.make("claude");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      ["a", "b", "c", "c", "d", "d"].map((slug) => ({
        slug,
        name: `Model ${slug.toUpperCase()}`,
      })),
    ],
  ]);
  const keybindings = compileResolvedKeybindingsConfig(
    ([1, 2, 3, 4, 5, 6] as const).map((index) => ({
      key: `mod+${index}`,
      command: `modelPicker.jump.${index}` as const,
      when: "modelPickerOpen",
    })),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model="a"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      keybindings={keybindings}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Model A/ })).toBeVisible();
  await vi.waitFor(() =>
    expect(
      page
        .getByRole("option")
        .elements()
        .map((row) => [
          row.textContent?.match(/Model [A-Z]/)?.[0],
          row.querySelector("kbd")?.textContent?.slice(-1),
        ]),
    ).toEqual([
      ["Model A", "1"],
      ["Model B", "2"],
      ["Model C", "3"],
      ["Model D", "4"],
    ]),
  );
});
