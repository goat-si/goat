import { EnvironmentId, ThreadId } from "@goat/contracts";
import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

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

const card: GoatBotTaskCard = {
  key: "task",
  revision: 1,
  updatedAt: "2026-10-12T09:40:00Z",
  title: "CJK 렌더링 확인",
  statusLabel: "Done",
  tone: "success",
  sourceLabel: null,
  summary: "결과는 **통과 (3/3)**입니다.\n- **빌드** 성공\n- `vp test` 통과",
  attentionLabel: null,
  pullRequests: [],
  target: {
    kind: "thread",
    environmentId: EnvironmentId.make("worker-home"),
    threadId: ThreadId.make("worker-thread"),
  },
};

it("renders a task result's Markdown summary in its card", async () => {
  await using screen = await render(<GoatBotTaskChip card={card} tail={false} />);
  await expect.element(screen.getByText("통과 (3/3)")).toBeVisible();
  const summary = screen.container.querySelector(".goat-task-summary");
  expect([...(summary?.querySelectorAll("strong") ?? [])].map((node) => node.textContent)).toEqual([
    "통과 (3/3)",
    "빌드",
  ]);
  expect(summary?.querySelectorAll("li")).toHaveLength(2);
  expect(summary?.textContent).not.toContain("**");
});
