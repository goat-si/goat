import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ supported: false, refresh: vi.fn(async () => undefined) }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () =>
        Atom.make(() => ({
          environment: { capabilities: { modelCatalogRefresh: state.supported } },
        })),
    },
  } as never;
});
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.refresh }) as never,
);
import { ProviderModelPicker } from "./ProviderModelPicker";

it("refreshes on each controlled open only when the destination advertises support", async () => {
  state.supported = true;
  state.refresh.mockClear();
  const props = {
    environmentId: EnvironmentId.make("env"),
    activeInstanceId: ProviderInstanceId.make("codex"),
    model: "model",
    lockedProvider: null,
    instanceEntries: [],
    modelOptionsByInstance: new Map(),
    onInstanceModelChange: () => {},
  };
  await using screen = await render(<ProviderModelPicker {...props} open={false} />);
  expect(state.refresh).not.toHaveBeenCalled();
  await screen.rerender(<ProviderModelPicker {...props} open />);
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
  expect(state.refresh).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { modelCatalogOnly: true },
  });
  await screen.rerender(<ProviderModelPicker {...props} open={false} />);
  state.supported = false;
  await screen.rerender(<ProviderModelPicker {...props} open />);
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
