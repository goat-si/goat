import { useLayoutEffect } from "react";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { GoatBotReplyStatus } from "./GoatBotReplyStatus";
import { useGoatBotReplyAnnouncement } from "./useGoatBotReplyAnnouncement";
import type { GoatBotSourceIds } from "./useGoatBotSource";

const row = (id: string, question = false): Extract<GoatBotRow, { kind: "bot" }> => ({
  kind: "bot",
  id,
  text: id,
  createdAt: "2026-10-12T09:40:00Z",
  tone: question ? "question" : "reply",
  proactive: question,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
function Status({
  source,
  rows,
}: {
  readonly source: GoatBotSourceIds;
  readonly rows: ReadonlyArray<GoatBotRow>;
}) {
  const { onExposure, announcement } = useGoatBotReplyAnnouncement("thread", source);
  return (
    <>
      <Exposure onExposure={onExposure} rows={rows} />
      <GoatBotReplyStatus announcement={announcement} />
    </>
  );
}
function Exposure({
  onExposure,
  rows,
}: {
  readonly onExposure: (rows: ReadonlyArray<GoatBotRow>) => void;
  readonly rows: ReadonlyArray<GoatBotRow>;
}) {
  useLayoutEffect(() => onExposure(rows), [onExposure, rows]);
  return null;
}
it("announces the newest source reply when an older row is exposed later during sync", async () => {
  const baseline = new Set<string>();
  const ids = new Set(["earliest", "older", "newer"]);
  const syncing = {
    identity: "thread",
    baselineIds: null,
    speechBaselineIds: baseline,
    sourceIds: ids,
  };
  const live = { identity: "thread", baselineIds: baseline, sourceIds: ids };
  const older = row("older");
  const newer = row("newer", true);
  await using screen = await render(<Status source={syncing} rows={[newer]} />);
  await screen.rerender(<Status source={syncing} rows={[older, newer]} />);
  await screen.rerender(<Status source={live} rows={[row("earliest")]} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("GOAT Bot asked a question.");
});
