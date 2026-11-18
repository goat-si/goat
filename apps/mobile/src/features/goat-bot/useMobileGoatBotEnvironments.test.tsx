import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
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
  // What GOAT Bot reads for the one computer, drawn so the test reads it like a person would.
  function Probe() {
    const refused = useMobileGoatBotEnvironments()[0]?.refused;
    return <span>{refused === undefined ? "not refused" : String(refused)}</span>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Probe />
        </RegistryContext>,
      ),
    );
    expect(container.textContent).toBe("not refused");
    await act(async () => registry.set(connectionRefusedAtom(env), true));
    expect(container.textContent).toBe("true");
    await act(async () => registry.set(connectionRefusedAtom(env), false));
    expect(container.textContent).toBe("not refused");
    await act(async () => registry.set(connectionRefusedAtom(env), true));
    await act(async () => registry.set(catalogAtom, listed([])));
    expect(container.textContent).toBe("not refused");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
