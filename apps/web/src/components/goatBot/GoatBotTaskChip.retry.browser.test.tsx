import { RegistryContext } from "@effect/atom-react";
import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  retry: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    retryTask: { permissionAtom: () => null },
    listBotThreads: (key: unknown) => ({ query: "listBotThreads", key }),
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.retry }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => null) as never,
  useEnvironmentShellsBootstrapped: (() => true) as never,
}));
import { GoatBotTaskChip } from "./GoatBotTaskChip";

const environmentId = EnvironmentId.make("env");
const card: GoatBotTaskCard = {
  key: "task-1",
  revision: 4,
  updatedAt: "2026-11-07T08:00:00.000Z",
  title: "Tidy the notes",
  statusLabel: "Failed",
  tone: "danger",
  sourceLabel: null,
  attemptLabel: "Attempt 2",
  retryable: true,
  summary: null,
  attentionLabel: null,
  pullRequests: [],
  target: { kind: "none", label: "No worker thread" },
};

function Chip(props: { readonly retryEnvironmentId: EnvironmentId | null }) {
  // Only refresh is read from the registry; the rest of the chip reads mocked state.
  const registry = { refresh: state.refresh } as never;
  return (
    <RegistryContext value={registry}>
      <GoatBotTaskChip card={card} retryEnvironmentId={props.retryEnvironmentId} />
    </RegistryContext>
  );
}

it("a retry started from a task card refreshes the bot's task list", async () => {
  state.retry.mockReset();
  state.refresh.mockReset();
  state.retry.mockResolvedValue({
    _tag: "Success",
    value: { status: "started", taskId: "task-1", generation: 3 },
  });
  await using screen = await render(<Chip retryEnvironmentId={environmentId} />);
  await expect.element(screen.getByText("· Attempt 2")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.retry).toHaveBeenCalledWith({
    environmentId,
    input: { taskId: "task-1", clientRequestId: expect.any(String) },
  });
  await vi.waitFor(() =>
    expect(state.refresh).toHaveBeenCalledWith({
      query: "listBotThreads",
      key: { environmentId, input: {} },
    }),
  );
});

it("a card without a retry environment offers no Retry", async () => {
  state.refresh.mockReset();
  await using screen = await render(<Chip retryEnvironmentId={null} />);
  await expect.element(screen.getByText("Tidy the notes")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});
