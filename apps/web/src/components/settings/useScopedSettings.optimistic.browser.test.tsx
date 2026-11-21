import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ environments: [] as unknown[], persist: vi.fn() }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  readEnvironment: ((id: string) =>
    state.environments.find((entry) => (entry as { environmentId: string }).environmentId === id) ??
    null) as never,
  usePrimaryEnvironmentId: (() =>
    (state.environments[0] as { environmentId: EnvironmentId }).environmentId) as never,
}));
vi.mock(import("./useSettingsProjectGroups"), () => ({ useSettingsProjectGroups: () => [] }));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { useUpdateScopedSettings } from "./useScopedSettings";
import { pendingScopedWritesAtom } from "./scopedSettingsOptimistic";

function Probe() {
  const { targets } = useSettingsScope();
  const save = useUpdateScopedSettings();
  return (
    <>
      <div data-testid="values">
        {targets
          .map(({ environmentId, settings }) => `${environmentId}:${settings.defaultAutoPull}`)
          .join(",")}
      </div>
      <button type="button" onClick={() => save({ defaultAutoPull: true })}>
        Save
      </button>
    </>
  );
}

it("shows pending changes per environment and rolls back only a failed save", async () => {
  const first = EnvironmentId.make("optimistic-first");
  const second = EnvironmentId.make("optimistic-second");
  state.environments = [first, second].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS, environment: { capabilities: {} } },
  }));
  let failFirst!: (value: ReturnType<typeof AsyncResult.failure>) => void;
  let succeedSecond!: (value: ReturnType<typeof AsyncResult.success>) => void;
  const failed = new Promise<ReturnType<typeof AsyncResult.failure>>((resolve) => {
    failFirst = resolve;
  });
  const succeeded = new Promise<ReturnType<typeof AsyncResult.success>>((resolve) => {
    succeedSecond = resolve;
  });
  state.persist
    .mockReset()
    .mockImplementation(({ environmentId }: { environmentId: EnvironmentId }) =>
      environmentId === first ? failed : succeeded,
    );
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <Probe />
      </SettingsScopeProvider>
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(state.persist).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("optimistic-first:true,optimistic-second:true");
  await act(async () => {
    failFirst(AsyncResult.failure(Cause.fail(new Error("denied"))));
    succeedSecond(AsyncResult.success({ ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true }));
    await Promise.all([failed, succeeded]);
  });
  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("optimistic-first:false,optimistic-second:true");
  expect(appAtomRegistry.get(pendingScopedWritesAtom).map((write) => write.environmentId)).toEqual([
    second,
  ]);
  state.environments = state.environments.map((value) => {
    const environment = value as {
      environmentId: EnvironmentId;
      serverConfig: { settings: typeof DEFAULT_SERVER_SETTINGS };
    };
    return environment.environmentId === second
      ? {
          ...environment,
          serverConfig: {
            ...environment.serverConfig,
            settings: { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
          },
        }
      : environment;
  });
  await screen.rerender(
    <RegistryContext.Provider value={appAtomRegistry}>
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <Probe />
      </SettingsScopeProvider>
    </RegistryContext.Provider>,
  );
  await vi.waitFor(() => expect(appAtomRegistry.get(pendingScopedWritesAtom)).toHaveLength(0));
  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("optimistic-first:false,optimistic-second:true");
});
