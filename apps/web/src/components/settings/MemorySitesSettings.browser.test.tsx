import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import { render } from "../../../test/render";
import { useAtomValue } from "@effect/atom-react";
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: vi.fn(),
}));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => true,
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  serverEnvironment: { updateSettings: { permissionAtom: () => "update" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/memory", async (original) => ({
  ...(await original<typeof import("../../state/memory")>()),
  memoryEnvironment: {
    siteNotesList: {
      permissionAtom: () => "siteNotes",
      run: () => Promise.resolve({ _tag: "Success", value: [] }),
    },
    siteNotesWrite: { permissionAtom: () => "siteNotes" },
  },
}));

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

function setup(available: boolean) {
  vi.mocked(useAtomValue).mockReset();
  vi.mocked(useAtomValue).mockImplementation(
    (atom) => ((atom as unknown) === "siteNotes" ? available : true) as never,
  );
}

it.each([false, true])(
  "renders agent access with site notes availability %s",
  async (available) => {
    setup(available);
    await using screen = await render(
      <MemoryAgentAccessSettings environmentId={EnvironmentId.make("test")} />,
    );
    await expect
      .element(screen.getByRole("switch", { name: "Allow agent memory access" }))
      .toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Site notes" });
    if (available) await expect.element(heading).toBeInTheDocument();
    else await expect.element(heading).not.toBeInTheDocument();
  },
);
