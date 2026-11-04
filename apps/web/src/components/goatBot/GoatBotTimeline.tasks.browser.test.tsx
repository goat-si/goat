import { EnvironmentId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

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
  await using screen = await render(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[row]} onRetry={() => {}} />,
  );
  await expect.element(screen.getByText("Check disks")).toBeVisible();
  await expect.element(screen.getByText("Running")).toBeVisible();
  expect(screen.getByText("Task thread · Check disks").query()).toBeNull();
  await screen.rerender(
    <GoatBotTimeline
      environmentId={EnvironmentId.make("env")}
      rows={[row]}
      taskThreads
      onRetry={() => {}}
    />,
  );
  await expect.element(screen.getByText("Task thread · Check disks")).toBeVisible();
});
