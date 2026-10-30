import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { render } from "../../../test/render";
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";

const fixture = vi.hoisted(() => ({ siteNotes: false }));

vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => true,
}));
vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...(await original<typeof import("../../state/server")>()),
    serverEnvironment: { updateSettings: { permissionAtom: () => allowed } },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/memory", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const siteNotes = Atom.make(() => fixture.siteNotes);
  return {
    ...(await original<typeof import("../../state/memory")>()),
    memoryEnvironment: {
      siteNotesList: {
        permissionAtom: () => siteNotes,
        run: () => Promise.resolve({ _tag: "Success", value: [] }),
      },
      siteNotesWrite: { permissionAtom: () => siteNotes },
    },
  };
});

vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsSection: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    control,
    children,
  }: {
    title: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {title}
      {control}
      {children}
    </div>
  ),
}));

function setup(siteNotes: boolean) {
  fixture.siteNotes = siteNotes;
}

it.each([false, true])(
  "keeps agent access usable and shows site notes only when the environment offers them (%s)",
  async (available) => {
    setup(available);
    await using screen = await render(
      <RegistryContext value={AtomRegistry.make()}>
        <MemoryAgentAccessSettings environmentId={EnvironmentId.make("test")} />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByRole("switch", { name: "Allow agent memory access" }))
      .toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Site notes" });
    if (available) await expect.element(heading).toBeInTheDocument();
    else await expect.element(heading).not.toBeInTheDocument();
  },
);
