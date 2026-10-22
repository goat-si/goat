import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ClientSettings,
  type GoatHostStatusResult,
  type ServerSettings,
} from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { type Locator } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  client: undefined as unknown,
  server: undefined as unknown,
  hosts: undefined as unknown,
  update: vi.fn(),
  record: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select(useAtomValue(state.client as Atom.Atom<ClientSettings>)),
  useEnvironmentSettings: (_id: string, select: (settings: ServerSettings) => unknown) =>
    select(useAtomValue(state.server as Atom.Atom<ServerSettings>)),
}));
vi.mock("./recordFirstRunPrompt", () => ({ recordFirstRunPrompt: state.record }));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../state/hostStatus", () => ({ hostStatusAtom: () => state.hosts }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    primaryServerConfigAtom: Atom.make({ environment: { environmentId: "local" } }),
    providersIgnoringCheckedAtAtom: () => Atom.make([]),
    serverEnvironment: {
      updateSettings: {
        label: "settings:update",
        run: state.update,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock("./ComputerUseFirstRunPrompt", () => ({
  ComputerUseFirstRunPrompt: () => <p>Computer use prompt</p>,
}));

import { FirstRunPrompts } from "./FirstRunPrompts";

const environmentId = EnvironmentId.make("local");

function setup() {
  const registry = AtomRegistry.make();
  const client = Atom.make<ClientSettings>({
    ...DEFAULT_CLIENT_SETTINGS,
    firstRunPrompts: { computerUse: "pending", opencodex: "answered", goatclaw: "pending" },
  });
  const server = Atom.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  state.client = client;
  state.server = server;
  state.hosts = Atom.make(
    AsyncResult.success<GoatHostStatusResult>({
      hosts: [
        {
          host: null,
          reachability: "ok",
          metrics: {
            sampledAt: 0,
            cpuCount: 8,
            cpuUtilization: null,
            availableMemoryBytes: 8,
            totalMemoryBytes: 16,
            loadAvg: null,
            disk: null,
            threads: { running: 0, waiting: 0, queued: 0 },
            quotas: [],
            opencodex: {
              installed: true,
              binaries: [],
              ownership: "adopted",
              service: { available: false },
              runtime: { port: 10100, healthy: true, ready: true },
              link: { role: "home", available: true, links: [], childSettingsApplied: null },
            },
          },
        },
      ],
    }),
  );
  state.record.mockReset().mockImplementation(async (id: string, value: string) => {
    const current = registry.get(client);
    registry.set(client, {
      ...current,
      firstRunPrompts: { ...current.firstRunPrompts, [id]: value },
    });
  });
  state.update
    .mockReset()
    .mockImplementation(
      async (_registry: unknown, { input }: { input: { patch: Partial<ServerSettings> } }) => {
        const current = registry.get(server);
        registry.set(server, { ...current, hub: { ...current.hub, ...input.patch.hub } });
        return { _tag: "Success", value: undefined };
      },
    );
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

async function press(locator: Locator) {
  await expect.element(locator).toBeInTheDocument();
  await act(() => (locator.element() as HTMLElement).click());
}

it("closes after Turn on without opening the next question in the same launch", async () => {
  using fixture = setup();
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <FirstRunPrompts />
    </RegistryContext>,
  );
  await press(screen.getByRole("switch", { name: "This machine is the hub" }));
  await press(screen.getByRole("button", { name: "Turn on" }));
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.update.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: { patch: { hub: { enabled: true } } },
  });
  expect(state.record.mock.calls).toEqual([["goatclaw", "answered"]]);
  await expect.element(screen.getByText("Computer use prompt")).not.toBeInTheDocument();
});
