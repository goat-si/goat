import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ServerSettings } from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { GTProvider } from "gt-react";
import zh from "../../i18n/translations/zh.json";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { MemoryAgentAccessSettings } from "./MemoryAgentAccessSettings";
import { MemoryGenerationSettings } from "./MemoryGenerationSettings";

const state = vi.hoisted(() => ({
  capable: true,
  write: vi.fn(),
}));
const settings = Atom.make(DEFAULT_UNIFIED_SETTINGS);
const permission = Atom.make(true);
const environmentId = EnvironmentId.make("remote-memory");

vi.mock("../../hooks/useSettings", async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original<typeof import("../../hooks/useSettings")>()),
    useEnvironmentSettings: (
      _id: EnvironmentId,
      select?: (s: typeof DEFAULT_UNIFIED_SETTINGS) => unknown,
    ) => {
      const current = useAtomValue(settings);
      return select ? select(current) : current;
    },
  };
});
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironmentProviders: () => new Map(),
  useEnvironment: () => ({
    serverConfig: {
      environment: {
        capabilities: { memory: state.capable ? { conversationMemoryControl: true } : {} },
      },
    },
  }),
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  serverEnvironment: { updateSettings: { permissionAtom: () => permission } },
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => state.write,
}));
vi.mock("./MemorySitesSettings", () => ({ MemorySitesSettings: () => null }));

async function setup(capable: boolean, allowed = true, locale = "en") {
  state.capable = capable;
  const registry = AtomRegistry.make();
  registry.set(settings, {
    ...DEFAULT_UNIFIED_SETTINGS,
    conversationMemoryEnabled: true,
    memoryEnabled: false,
    enableAgentMemoryAccess: true,
  });
  registry.set(permission, allowed);
  state.write
    .mockReset()
    .mockImplementation(
      ({ input }: { input: { patch: Pick<ServerSettings, "conversationMemoryEnabled"> } }) => {
        registry.set(settings, { ...registry.get(settings), ...input.patch });
        return Promise.resolve({ _tag: "Success" });
      },
    );
  return render(
    <RegistryContext value={registry}>
      <GTProvider locale={locale} translations={{ zh }}>
        <MemoryGenerationSettings environmentId={environmentId} />
        <MemoryAgentAccessSettings environmentId={environmentId} />
      </GTProvider>
    </RegistryContext>,
  );
}

it("pauses only conversation memory on the selected device and restores existing preferences", async () => {
  await using screen = await setup(true);
  const master = screen.getByRole("switch", { name: "Use GOAT memory in conversations" });
  const summaries = screen.getByRole("switch", { name: "Remember conversations" });
  const access = screen.getByRole("switch", { name: "Allow agent memory access" });
  await expect.element(master).toHaveAccessibleDescription(/Messages from this period/);
  await master.click();
  await expect.element(master).not.toBeChecked();
  await expect.element(summaries).toBeDisabled();
  await expect.element(summaries).not.toBeChecked();
  await expect.element(access).toBeDisabled();
  await expect.element(access).toBeChecked();
  await master.click();
  await expect.element(summaries).toBeEnabled();
  await expect.element(summaries).not.toBeChecked();
  await expect.element(access).toBeEnabled();
  await expect.element(access).toBeChecked();
  expect(state.write.mock.calls.map(([call]) => call)).toEqual(
    [false, true].map((conversationMemoryEnabled) => ({
      environmentId,
      input: { patch: { conversationMemoryEnabled } },
    })),
  );
});

it("keeps the existing controls on an older server", async () => {
  await using screen = await setup(false);
  await expect
    .element(screen.getByRole("switch", { name: "Use GOAT memory in conversations" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("switch", { name: "Remember conversations" }))
    .toBeEnabled();
});

it("requires settings permission to pause conversations", async () => {
  await using screen = await setup(true, false);
  await expect
    .element(screen.getByRole("switch", { name: "Use GOAT memory in conversations" }))
    .toBeDisabled();
});

it("keeps the previous selection and explains a rejected change in the chosen language", async () => {
  await using screen = await setup(true, true, "zh");
  state.write.mockResolvedValueOnce({ _tag: "Failure" });
  const master = screen.getByRole("switch", { name: "在对话中使用 GOAT 记忆" });
  await master.click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("无法更新记忆设置。");
  await expect.element(master).toBeChecked();
  await expect.element(master).toBeEnabled();
});
