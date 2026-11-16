import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make<unknown>({ isReady: true, entries: new Map() }),
    },
  };
});
// The phone's computers as the GOAT Bot screens see them: one listed computer, not connected.
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env",
        label: "Mac Studio",
        connection: { phase: "error" },
        serverConfig: null,
      },
    ],
  }),
}));

import { environmentCatalog } from "../../connection/catalog";
import { connectionRefusedAtom, resetKeptPerComputerForTests } from "./keptPerComputerStore";
import { useMobileGoatBotEnvironments } from "./useMobileGoatBotEnvironments";

const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<unknown>;
const listed = (ids: string[]) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});

it("a computer that refused this phone reaches GOAT Bot as refused, until it connects or leaves the list (#3550, access)", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  registry.set(catalogAtom, listed(["env"]));
  const env = EnvironmentId.make("env");
  let inputs: ReadonlyArray<GoatBotEnvironmentInput> = [];
  function Probe() {
    inputs = useMobileGoatBotEnvironments();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Probe />
        </RegistryContext>,
      ),
    );
    expect(inputs[0]?.refused).toBeUndefined();
    await act(async () => registry.set(connectionRefusedAtom(env), true));
    expect(inputs[0]?.refused).toBe(true);
    await act(async () => registry.set(connectionRefusedAtom(env), false));
    expect(inputs[0]?.refused).toBeUndefined();
    await act(async () => registry.set(connectionRefusedAtom(env), true));
    await act(async () => registry.set(catalogAtom, listed([])));
    expect(inputs[0]?.refused).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
