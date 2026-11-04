import { EnvironmentId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ supported: false }));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotTaskThreads: state.supported } } }]]),
}));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => <div>Legacy task card</div> }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";

const row: GoatBotRow = {
  kind: "task",
  id: "card",
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 1,
    updatedAt: "2026-10-12T09:40:00Z",
    title: "Check disks",
    statusLabel: "Running",
    tone: "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "Unavailable" },
  },
};
it("offers task threads only when the server supports them", async () => {
  state.supported = false;
  await using screen = await render(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[row]} onRetry={() => {}} />,
  );
  await expect.element(screen.getByText("Legacy task card")).toBeVisible();
  expect(screen.getByText("Task thread · Check disks").query()).toBeNull();
  state.supported = true;
  await screen.rerender(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[row]} onRetry={() => {}} />,
  );
  await expect.element(screen.getByText("Task thread · Check disks")).toBeVisible();
});
