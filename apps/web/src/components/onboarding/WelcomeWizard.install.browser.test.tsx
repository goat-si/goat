import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AuthTerminalReadScope, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown,
  config: null as unknown,
  running: null as unknown,
  canRead: true,
  refresh: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => {
  const environment = {
    environmentId: EnvironmentId.make("install-test"),
    label: "Test machine",
    connection: { phase: "connected" },
    entry: { enabled: true, target: { _tag: "PrimaryConnectionTarget" }, profile: Option.none() },
  };
  return {
    ...(await original()),
    usePrimaryEnvironment: (() => environment) as never,
    useEnvironments: (() => ({ environments: [environment] })) as never,
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_environmentId: unknown, scope: unknown) =>
    scope !== AuthTerminalReadScope || state.canRead) as never,
  readEnvironmentScope: ((_environmentId: unknown, scope: unknown) =>
    scope !== AuthTerminalReadScope || state.canRead) as never,
  useEnvironmentsWithScope: (() => new Set()) as never,
}));
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: {
    ...(await original()).serverEnvironment,
    providersValueAtom: (() => state.providers) as never,
    configValueAtom: (() => state.config) as never,
    refreshProviders: "refresh" as never,
  },
}));
vi.mock(import("../../state/terminal"), async (original) => ({
  ...(await original()),
  terminalEnvironment: {
    ...(await original()).terminalEnvironment,
    open: "open",
    write: "write",
    close: "close",
  } as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useThreadRunningTerminalIds: () => useAtomValue(state.running as Atom.Atom<readonly string[]>),
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "refresh" | "open" | "write" | "close") => state[command]) as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: () => [],
}));
vi.mock(import("../ThreadTerminalDrawer"), async (original) => ({
  ...(await original()),
  TerminalViewport: () => <div />,
}));
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => null,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomeWizard } from "./WelcomeWizard";

it("rechecks the installed provider after the setup command exits", async () => {
  const environmentId = EnvironmentId.make("install-test");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  state.canRead = true;
  state.running = Atom.make<readonly string[]>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make([
    {
      driver: "claudeAgent",
      instanceId,
      displayName: "Claude",
      enabled: true,
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      models: [],
    },
  ]).pipe(Atom.keepAlive);
  state.config = Atom.make({
    cwd: "/test",
    environment: { platform: { os: "darwin" } },
    settings: { providerInstances: {} },
    keybindings: [],
  }).pipe(Atom.keepAlive);
  for (const command of [state.refresh, state.open, state.write, state.close])
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomeWizard localAvailable resumeEnvironmentId={environmentId} onDone={() => {}} />
    </RegistryContext.Provider>,
  );
  await userEvent.click(page.getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(state.write).toHaveBeenCalledOnce());
  const { terminalId } = state.open.mock.calls[0]![0].input;
  const running = state.running as Atom.Writable<readonly string[]>;
  state.refresh.mockClear();
  await act(async () => appAtomRegistry.set(running, [terminalId]));
  expect(state.refresh).not.toHaveBeenCalled();
  await act(async () => appAtomRegistry.set(running, []));
  expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  expect(state.close).not.toHaveBeenCalled();
  state.refresh.mockClear();
  await act(async () => appAtomRegistry.set(running, [terminalId]));
  state.canRead = false;
  await act(async () => appAtomRegistry.set(running, []));
  expect(state.refresh).not.toHaveBeenCalled();
});
