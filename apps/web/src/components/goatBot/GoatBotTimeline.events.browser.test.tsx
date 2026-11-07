import { EnvironmentId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";

const event: GoatBotRow = {
  kind: "event",
  id: "event",
  text: "Routine Check in paused",
  createdAt: "2026-11-07T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
};

it("shows a bot event as a note line in the conversation", async () => {
  await using screen = await render(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[event]} onRetry={() => {}} />,
  );
  await expect
    .element(screen.getByRole("note").filter({ hasText: "Routine Check in paused" }))
    .toBeVisible();
});
