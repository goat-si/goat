import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type SiteNoteListEntry } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { render } from "../../../test/render";
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";

type ListResult = { readonly _tag: "Success"; readonly value: ReadonlyArray<SiteNoteListEntry> };
const fixture = vi.hoisted(() => ({
  siteNotes: false,
  held: false,
  lists: [] as Array<(result: ListResult) => void>,
}));

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
        run: () =>
          fixture.held
            ? new Promise((resolve) => fixture.lists.push(resolve))
            : Promise.resolve({ _tag: "Success", value: [] }),
      },
      siteNotesWrite: {
        permissionAtom: () => siteNotes,
        run: () => Promise.resolve({ _tag: "Success", value: undefined }),
      },
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

function setup(siteNotes: boolean, held = false) {
  fixture.siteNotes = siteNotes;
  fixture.held = held;
  fixture.lists = [];
}

const savedNote: SiteNoteListEntry = {
  origin: "https://example.com",
  text: "Fresh note",
  author: "person",
  updatedAt: null,
  seed: false,
  hidden: false,
};

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

it("keeps a saved note when the first list request answers after the reload", async () => {
  setup(true, true);
  await using screen = await render(
    <RegistryContext value={AtomRegistry.make()}>
      <MemoryAgentAccessSettings environmentId={EnvironmentId.make("test")} />
    </RegistryContext>,
  );
  await userEvent.fill(screen.getByLabelText("Site address"), savedNote.origin);
  await userEvent.fill(screen.getByLabelText("Site note"), savedNote.text);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(2));
  const [initial, reload] = fixture.lists;
  reload?.({ _tag: "Success", value: [savedNote] });
  await expect.element(screen.getByText(savedNote.text)).toBeInTheDocument();
  initial?.({ _tag: "Success", value: [] });
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await expect.element(screen.getByLabelText(`Note for ${savedNote.origin}`)).toBeInTheDocument();
});
