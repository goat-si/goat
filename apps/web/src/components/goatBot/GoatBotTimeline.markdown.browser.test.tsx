import { EnvironmentId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

// Atoms derived from the server config run in the real registry over a missing config.
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
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

const environmentId = EnvironmentId.make("bot-home");
const bot = (id: string, text: string): GoatBotRow => ({
  kind: "bot",
  id,
  text,
  createdAt: "2026-10-12T09:40:00Z",
  tone: "reply",
  proactive: true,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});

it("renders an answer's markdown in its bubble, including emphasis written the CJK way", async () => {
  await using screen = await render(
    <GoatBotTimeline
      environmentId={environmentId}
      onRetry={() => {}}
      rows={[
        bot(
          "hardware",
          "이 컴퓨터에는 **논리 CPU 코어 32개**와 **메모리 약 125.6 GiB**(134,864,097,280바이트)가 있습니다.",
        ),
        bot(
          "os",
          "운영체제는 **Windows 11 Pro, 버전 10.0.26200 (빌드 26200)**이며\nこれは**「重要」**です。",
        ),
        bot("list", "확인한 것:\n- *빌드* `vp test`\n- 둘째"),
        bot("code", "    indented code"),
      ]}
    />,
  );
  const { container } = screen;
  const texts = (selector: string) =>
    [...container.querySelectorAll(`.chat-markdown ${selector}`)].map((node) => node.textContent);
  await expect.element(screen.getByText("논리 CPU 코어 32개")).toBeVisible();
  expect(texts("strong")).toEqual([
    "논리 CPU 코어 32개",
    "메모리 약 125.6 GiB",
    "Windows 11 Pro, 버전 10.0.26200 (빌드 26200)",
    "「重要」",
  ]);
  expect(texts("em")).toEqual(["빌드"]);
  expect(texts("li")).toEqual(["빌드 vp test", "둘째"]);
  expect(texts("pre")).toEqual(["indented code\n"]);
  expect(texts("br")).toHaveLength(1);
  expect(container.textContent).not.toContain("**");
});

it("keeps plain answers as written, with their addresses linked", async () => {
  const text = "Stars: 17.8k\nURL: https://github.com/example/opencodex";
  await using screen = await render(
    <GoatBotTimeline
      environmentId={environmentId}
      onRetry={() => {}}
      rows={[bot("plain", text)]}
    />,
  );
  await expect
    .element(screen.getByRole("link", { name: "https://github.com/example/opencodex" }))
    .toHaveAttribute("href", "https://github.com/example/opencodex");
  expect(screen.container.querySelector(".goat-bubble")?.textContent).toBe(text);
});

it("opens thread links in the environment whose history is shown", async () => {
  const row = bot("link", "작업은 [CJK 렌더링](goat-thread://v1/worker-thread)에서 진행했습니다.");
  await using screen = await render(
    <GoatBotTimeline environmentId={environmentId} onRetry={() => {}} rows={[row]} />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Thread, CJK 렌더링" }))
    .toHaveAttribute("href", "/bot-home/worker-thread");
  await screen.rerender(<GoatBotTimeline environmentId={null} onRetry={() => {}} rows={[row]} />);
  await expect.element(screen.getByText("CJK 렌더링")).toBeVisible();
  expect(screen.container.querySelector(".chat-markdown a")).toBeNull();
});
