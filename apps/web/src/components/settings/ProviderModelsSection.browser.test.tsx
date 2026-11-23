import "../../index.css";
import { useState } from "react";
import { ProviderDriverKind, ProviderInstanceId, type ServerProviderModel } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act } from "../../../test/render";

import { render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

it("lists a favorite the provider no longer reports so it can be unstarred", async () => {
  const onToggleFavorite = vi.fn();
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={["retired-model"]}
      modelOrder={[]}
      onChange={() => {}}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={onToggleFavorite}
      onModelOrderChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Remove retired-model from favorites" }).click();
  expect(onToggleFavorite).toHaveBeenCalledWith("retired-model");
});

it("keeps a custom model draft until a save succeeds and ignores a late result after cancel", async () => {
  let resolveSave!: (saved: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    resolveSave = resolve;
  });
  const onChange = vi.fn(() => pending);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-one");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-two");
  await act(async () => {
    resolveSave(true);
    await pending;
  });
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-two");
});

it("keeps a custom model draft when persistence fails", async () => {
  const onChange = vi.fn().mockResolvedValue(false);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-one");
});

it("closes a custom model draft after the server confirms it", async () => {
  const onChange = vi.fn().mockResolvedValue(true);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Add custom model" })).toBeVisible();
});

it("keeps a model edit open when saving fails", async () => {
  const kept = { slug: "model-a", name: "Original A", capabilities: null };
  const onChange = vi.fn().mockResolvedValue(false);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[{ ...kept, isCustom: true }]}
      customModels={[kept]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit model-a" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "Display name" }), "Draft A");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Draft A");
});

it("keeps model edits typed while an earlier save succeeds", async () => {
  const kept = { slug: "model-a", name: "Original A", capabilities: null };
  let complete!: (saved: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[{ ...kept, isCustom: true }]}
      customModels={[kept]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={() => pending}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit model-a" }));
  const name = screen.getByRole("textbox", { name: "Display name" });
  await userEvent.fill(name, "First draft");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await userEvent.fill(name, "New draft");
  await act(async () => {
    complete(true);
    await pending;
  });
  await expect.element(name).toHaveValue("New draft");
});

const models: ServerProviderModel[] = ["a", "b", "c", "d", "e"].map((id) => ({
  slug: `model-${id}`,
  name: `Model ${id.toUpperCase()}`,
  isCustom: false,
  capabilities: null,
}));

function StatefulModelsSection() {
  const [hiddenModels, setHiddenModels] = useState<ReadonlyArray<string>>(
    models.map((model) => model.slug),
  );
  return (
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={models}
      customModels={[]}
      canManageCustomModels
      hiddenModels={hiddenModels}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={async () => true}
      onHiddenModelsChange={setHiddenModels}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />
  );
}

const rowSlugs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-model-slug]"), (row) =>
    row.getAttribute("data-model-slug"),
  );

it("keeps a model in place when it is shown again after disabling all", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const order = models.map((model) => model.slug);
  expect(rowSlugs(screen.container)).toEqual(order);

  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(order);
});

it("regroups the list when all models are disabled and enabled again", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  await screen.getByRole("button", { name: "Disable all" }).click();
  await screen.getByRole("button", { name: "Enable all" }).click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(models.map((model) => model.slug));
});
