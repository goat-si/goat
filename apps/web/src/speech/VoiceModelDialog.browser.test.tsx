import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const fixture = vi.hoisted(() => ({
  acceleration: "auto",
  pending: null as Promise<never> | null,
}));
vi.mock("../state/session", async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock("@goat/client-runtime/voice-input", async (original) => ({
  ...(await original()),
  listEnvironmentSpeechModels: async (context: { id: string }) =>
    context.id === "other" && fixture.pending
      ? fixture.pending
      : {
          models: [
            {
              id: "a",
              name: "Alpha",
              description: "",
              size: 1,
              installed: false,
              selected: false,
              benchmark: { cpu: 10, accelerated: 1 },
            },
            {
              id: "b",
              name: "Beta",
              description: "",
              size: 1,
              installed: false,
              selected: false,
              benchmark: { cpu: 2, accelerated: 8 },
            },
          ],
        },
  getEnvironmentSpeechConfiguration: async () => ({
    modelId: "a",
    acceleration: fixture.acceleration,
  }),
}));

import { render } from "../../test/render";
import { VoiceModelDialog } from "./VoiceModelDialog";

it("shows labelled reference times and sorts using the chosen hardware", async () => {
  fixture.acceleration = "auto";
  fixture.pending = null;
  await using _screen = await render(
    <VoiceModelDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make("env")}
      label="Test"
      canManage
      resolveContext={async (id) => ({ id }) as never}
    />,
    { router: false }, // The model dialog does not use routing.
  );
  await expect.element(page.getByText("Alpha")).toBeVisible();
  await expect.element(page.getByText("Reference time for 30 s: CPU 10 s · GPU 1 s")).toBeVisible();
  const select = page.getByRole("combobox", { name: "Sort models" }).element() as HTMLSelectElement;
  const order = () =>
    [...document.querySelectorAll("p")]
      .map((p) => p.textContent)
      .filter((text) => text === "Alpha" || text === "Beta");
  await userEvent.selectOptions(select, "speed-cpu");
  expect(order()).toEqual(["Beta", "Alpha"]);
  await userEvent.selectOptions(select, "speed-gpu");
  expect(order()).toEqual(["Alpha", "Beta"]);
});

it.each([
  { acceleration: "cpu", wanted: "CPU 10 s", unwanted: "GPU" },
  { acceleration: 'gpu:["vulkan","device"]', wanted: "GPU 1 s", unwanted: "CPU" },
])(
  "displays the $acceleration reference without substituting another tier",
  async ({ acceleration, wanted, unwanted }) => {
    fixture.acceleration = acceleration;
    fixture.pending = null;
    await using _screen = await render(
      <VoiceModelDialog
        open
        onOpenChange={() => {}}
        environmentId={EnvironmentId.make("env")}
        label="Test"
        canManage
        resolveContext={async (id) => ({ id }) as never}
      />,
      { router: false }, // The model dialog does not use routing.
    );
    await expect.element(page.getByText(`Reference time for 30 s: ${wanted}`)).toBeVisible();
    const descriptions = [...document.querySelectorAll("p")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.startsWith("Reference time for 30 s:"));
    expect(descriptions).toHaveLength(2);
    expect(descriptions.every((text) => !text.includes(unwanted))).toBe(true);
  },
);

it("does not show another environment's references while the new environment loads", async () => {
  fixture.acceleration = "auto";
  fixture.pending = new Promise<never>(() => {});
  const dialog = (id: string) => (
    <VoiceModelDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make(id)}
      label={id}
      canManage
      resolveContext={async (environmentId) => ({ id: environmentId }) as never}
    />
  );
  await using screen = await render(dialog("first"), { router: false }); // The dialog does not use routing.
  await expect.element(page.getByText("Reference time for 30 s: CPU 10 s · GPU 1 s")).toBeVisible();
  await screen.rerender(dialog("other"));
  await expect
    .element(page.getByText("Reference time for 30 s: CPU 10 s · GPU 1 s"))
    .not.toBeInTheDocument();
  fixture.pending = null;
});

it("does not keep GPU sorting when switching to a CPU-configured environment", async () => {
  fixture.acceleration = "auto";
  fixture.pending = null;
  const dialog = (id: string) => (
    <VoiceModelDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make(id)}
      label={id}
      canManage
      resolveContext={async (environmentId) => ({ id: environmentId }) as never}
    />
  );
  await using screen = await render(dialog("first"), { router: false }); // The dialog does not use routing.
  await expect.element(page.getByText("Alpha")).toBeVisible();
  await userEvent.selectOptions(
    page.getByRole("combobox", { name: "Sort models" }).element(),
    "speed-gpu",
  );
  fixture.acceleration = "cpu";
  await screen.rerender(dialog("cpu-env"));
  await expect.element(page.getByText("Reference time for 30 s: CPU 10 s")).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Sort models" }))
    .toHaveValue("recommended");
});
