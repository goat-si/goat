import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type SiteNoteListEntry } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, render } from "../../../test/render";
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";

type ListResult = { readonly _tag: "Success"; readonly value: ReadonlyArray<SiteNoteListEntry> };
const fixture = vi.hoisted(() => ({
  siteNotes: false,
  held: false,
  lists: [] as Array<{ environmentId: string; resolve: (result: ListResult) => void }>,
  holdWrites: false,
  writes: [] as Array<() => void>,
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
        run: (_registry: unknown, { environmentId }: { environmentId: string }) =>
          fixture.held
            ? new Promise((resolve) => fixture.lists.push({ environmentId, resolve }))
            : Promise.resolve({ _tag: "Success", value: [] }),
      },
      siteNotesWrite: {
        permissionAtom: () => siteNotes,
        run: () =>
          fixture.holdWrites
            ? new Promise((resolve) =>
                fixture.writes.push(() => resolve({ _tag: "Success", value: undefined })),
              )
            : Promise.resolve({ _tag: "Success", value: undefined }),
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
  fixture.holdWrites = false;
  fixture.writes = [];
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
  reload?.resolve({ _tag: "Success", value: [savedNote] });
  await expect.element(screen.getByText(savedNote.text)).toBeInTheDocument();
  initial?.resolve({ _tag: "Success", value: [] });
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await expect.element(screen.getByLabelText(`Note for ${savedNote.origin}`)).toBeInTheDocument();
});

it("does not show a late list from a previous environment", async () => {
  setup(true, true);
  const registry = AtomRegistry.make();
  const view = (id: string) => (
    <RegistryContext value={registry}>
      <MemoryAgentAccessSettings environmentId={EnvironmentId.make(id)} />
    </RegistryContext>
  );
  await using screen = await render(view("a"));
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(1));
  await screen.rerender(view("b"));
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(2));
  expect(fixture.lists.map((list) => list.environmentId)).toEqual(["a", "b"]);
  fixture.lists[1]?.resolve({ _tag: "Success", value: [] });
  await act(async () => fixture.lists[0]?.resolve({ _tag: "Success", value: [savedNote] }));
  await expect.element(screen.getByText(savedNote.text)).not.toBeInTheDocument();
});

it("keeps the current environment list when a previous environment save finishes", async () => {
  setup(true, true);
  fixture.holdWrites = true;
  const registry = AtomRegistry.make();
  const view = (id: string) => (
    <RegistryContext value={registry}>
      <MemoryAgentAccessSettings environmentId={EnvironmentId.make(id)} />
    </RegistryContext>
  );
  await using screen = await render(view("a"));
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(1));
  fixture.lists[0]?.resolve({ _tag: "Success", value: [savedNote] });
  await expect.element(screen.getByText(savedNote.text)).toBeInTheDocument();
  await userEvent.fill(screen.getByLabelText("Site address"), "https://other.example");
  await userEvent.fill(screen.getByLabelText("Site note"), "Other note");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(fixture.writes).toHaveLength(1));
  await screen.rerender(view("b"));
  await expect.element(screen.getByText(savedNote.text)).not.toBeInTheDocument();
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(2));
  const bNote = { ...savedNote, text: "Environment B note" };
  fixture.lists[1]?.resolve({ _tag: "Success", value: [bNote] });
  await expect.element(screen.getByText(bNote.text)).toBeInTheDocument();
  fixture.writes[0]?.();
  await vi.waitFor(() => expect(fixture.lists).toHaveLength(3));
  expect(fixture.lists[2]?.environmentId).toBe("a");
  await act(async () => fixture.lists[2]?.resolve({ _tag: "Success", value: [savedNote] }));
  await expect.element(screen.getByText(savedNote.text)).not.toBeInTheDocument();
  await expect.element(screen.getByText(bNote.text)).toBeInTheDocument();
});
