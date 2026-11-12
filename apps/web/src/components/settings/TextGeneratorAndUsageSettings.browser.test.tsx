import { EnvironmentId } from "@goat/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: false,
  update: vi.fn(async (_value: unknown) => ({ _tag: "Success" })),
}));
vi.mock(
  import("@effect/atom-react"),
  async (original) =>
    ({
      ...((await original()) as typeof import("@effect/atom-react")),
      useAtomValue: () => ({ environment: { capabilities: { textGenerators: state.supported } } }),
    }) as never,
);
vi.mock(
  import("../../hooks/useSettings"),
  async (original) =>
    ({
      ...((await original()) as typeof import("../../hooks/useSettings")),
      useEnvironmentSettings: () => ({ textGenerators: {} }),
    }) as never,
);
vi.mock(
  import("../../state/session"),
  async (original) =>
    ({
      ...((await original()) as typeof import("../../state/session")),
      useEnvironmentScope: () => true,
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.update }) as never,
);
vi.mock(
  import("./UsageProviderSettings"),
  () => ({ UsageProviderSettings: () => <div>Usage settings</div> }) as never,
);
vi.mock(
  import("./settingsLayout"),
  () =>
    ({
      SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
      SettingsRow: ({ title, control }: { title: ReactNode; control?: ReactNode }) => (
        <div>
          {title}
          {control}
        </div>
      ),
    }) as never,
);
import { UsageProviderSettings } from "./TextGeneratorAndUsageSettings";

it("offers API generators only on a server that supports them and saves to that environment", async () => {
  state.supported = false;
  state.update.mockClear();
  const props = {
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
    sources: {},
    cursorKeychainUsageEnabled: false,
    readOnly: false,
  };
  await using screen = await render(<UsageProviderSettings {...props} />);
  await expect
    .element(screen.getByRole("button", { name: "Add text generator" }))
    .not.toBeInTheDocument();
  state.supported = true;
  await screen.rerender(<UsageProviderSettings {...props} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "API base URL" }),
    "https://model.example/v1",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Model ID" }), "small-model");
  await userEvent.type(screen.getByLabelText("API key"), "fixture-key");
  await userEvent.click(screen.getByRole("button", { name: "Add text generator" }));
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  expect(state.update.mock.calls[0]![0]).toMatchObject({
    environmentId: "remote",
    input: { patch: { textGenerators: expect.any(Object) } },
  });
});
