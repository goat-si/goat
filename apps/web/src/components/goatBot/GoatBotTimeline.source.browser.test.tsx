import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ThreadId, type OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";

vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadStatus: () => "live",
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { useGoatBotSource } from "./useGoatBotSource";
import { GoatBotTimeline } from "./GoatBotTimeline";

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const item = (id: string) =>
  ({ item: { id, type: "assistant_message" } }) as unknown as OrchestrationV2ProjectedTurnItem;
const bot = (id: string): GoatBotRow => ({
  kind: "bot",
  id,
  text: `Message ${id}`,
  createdAt: "2026-11-01T00:00:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
function Timeline({
  displayed,
  membership,
}: {
  displayed: ReadonlyArray<GoatBotRow>;
  membership: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}) {
  const source = useGoatBotSource(
    ref,
    "member",
    displayed.map((row) => item(row.id)),
    membership,
  );
  return (
    <GoatBotTimeline
      rows={displayed}
      baselineIds={source.baselineIds}
      sourceIds={source.sourceIds}
      onRetry={() => {}}
    />
  );
}
it("baselines the live projection before gated route history becomes visible", async () => {
  const history = Array.from({ length: 40 }, (_, i) => bot(`h${i}`));
  const baseline = [...history.map((row) => item(row.id)), item("hidden")];
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  await using screen = await render(<Timeline displayed={[]} membership={baseline} />, {
    container: host,
    router: false,
  }); // No links in these rows.
  await screen.rerender(<Timeline displayed={history} membership={baseline} />);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(<Timeline displayed={[...history, bot("hidden")]} membership={baseline} />);
  expect(screen.container.textContent).not.toContain("Jump to latest");
  await screen.rerender(
    <Timeline
      displayed={[...history, bot("hidden"), bot("fresh")]}
      membership={[...baseline, item("fresh")]}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Jump to latest", exact: true }))
    .toBeVisible();
});
