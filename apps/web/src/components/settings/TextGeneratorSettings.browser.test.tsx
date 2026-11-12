import { expect, it, vi } from "vite-plus/test";
import type { ServerSettingsPatch } from "@goat/contracts";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TextGeneratorSettings } from "./TextGeneratorSettings";

it("saves a model API and clears the key draft", async () => {
  const save = vi.fn(async (_patch: ServerSettingsPatch) => true);
  await using screen = await render(
    <TextGeneratorSettings generators={{}} canManage canSelect onPatch={save} />,
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "API base URL" }),
    "https://api.example/v1",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Model ID" }), "small-model");
  await userEvent.type(screen.getByLabelText("API key"), "fixture-key");
  await userEvent.click(screen.getByRole("button", { name: "Add text generator" }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  const patch = save.mock.calls[0]![0];
  expect(Object.values(patch.textGenerators ?? {})[0]).toMatchObject({
    baseUrl: "https://api.example/v1",
    model: "small-model",
    apiKey: "fixture-key",
  });
  expect(screen.getByLabelText("API key").element()).toHaveValue("");
});

it("selects the saved model for titles and source control", async () => {
  const save = vi.fn(async (_patch: ServerSettingsPatch) => true);
  await using screen = await render(
    <TextGeneratorSettings
      canManage
      canSelect
      onPatch={save}
      generators={{
        saved: {
          kind: "openaiCompatible",
          baseUrl: "https://api.example/v1",
          model: "small-model",
          apiKey: "••••••",
          enabled: true,
        },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Use for text generation" }));
  await userEvent.click(screen.getByRole("button", { name: "Use for source control" }));
  expect(save.mock.calls[0]![0].textGenerationModelSelection).toEqual({
    instanceId: "saved",
    model: "small-model",
  });
  expect(save.mock.calls[1]![0].sourceControlWriterModelSelection).toEqual({
    instanceId: "saved",
    model: "small-model",
  });
});

it("preserves a stored key when editing the endpoint", async () => {
  const save = vi.fn(async (_patch: ServerSettingsPatch) => true);
  await using screen = await render(
    <TextGeneratorSettings
      canManage
      canSelect
      onPatch={save}
      generators={{
        saved: {
          kind: "openaiCompatible",
          label: "Saved",
          baseUrl: "https://old.example/v1",
          model: "model",
          apiKey: "••••••",
          enabled: true,
        },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("API key").element()).toHaveValue("");
  await userEvent.clear(screen.getByRole("textbox", { name: "API base URL" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "API base URL" }),
    "https://new.example/v1",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save text generator" }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(Object.values(save.mock.calls[0]![0].textGenerators ?? {})[0]).toMatchObject({
    baseUrl: "https://new.example/v1",
    apiKey: "••••••",
  });
});

it("disables selection for a disabled generator and preserves its key when enabling it", async () => {
  const save = vi.fn(async (_patch: ServerSettingsPatch) => true);
  await using screen = await render(
    <TextGeneratorSettings
      canManage
      canSelect
      onPatch={save}
      generators={{
        saved: {
          kind: "openaiCompatible",
          baseUrl: "https://api.example/v1",
          model: "small-model",
          apiKey: "••••••",
          enabled: false,
        },
      }}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Use for text generation" }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Enable" }));
  expect(Object.values(save.mock.calls[0]![0].textGenerators ?? {})[0]).toMatchObject({
    enabled: true,
    apiKey: "••••••",
  });
});
