import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, MemoryId, MemorySpaceId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { afterEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  supported: true,
  allowed: true,
  destination: null as Record<string, unknown> | null,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: (environmentId: string) => ({
    environmentId,
    serverConfig: {
      environment: { capabilities: state.supported ? { memory: { protocolVersion: 1 } } : {} },
    },
  }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => state.allowed,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async (input: { search: Record<string, unknown> }) => {
    state.destination = input.search;
  },
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@goat/contracts/settings");
  return {
    ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
    usePrimarySettings: () => "system",
    useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = {
  kind: "bot",
  id: "synthetic-report",
  createdAt: "2026-10-01T00:00:00Z",
  firstInGroup: true,
  groupPosition: "single",
  text: "A memory conflict was resolved.",
  tone: "result",
  proactive: false,
  replyTo: null,
  options: [],
  memory: {
    environmentId: EnvironmentId.make("foreign-owner"),
    memorySpaceId: MemorySpaceId.make(id(1)),
    memoryId: MemoryId.make(id(2)),
  },
} satisfies GoatBotRow;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  state.allowed = true;
  state.supported = true;
  state.destination = null;
  vi.unstubAllGlobals();
});
it("opens the report's foreign destination and preserves plain text when support or read access disappears", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const render = () => root.render(<GoatBotTimeline rows={[row]} onRetry={() => {}} />);
  await act(async () => render());
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === "View memory details",
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(state.destination).toMatchObject(row.memory);
  expect(state.destination?.project).toBeUndefined();
  expect(state.destination?.checkout).toBeUndefined();
  state.allowed = false;
  await act(async () => render());
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain(row.text);
  state.allowed = true;
  state.supported = false;
  await act(async () => render());
  expect(container.querySelector("button")).toBeNull();
});
