import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { ChannelGetBotStatusResult } from "@goat/contracts";

/** One bot that waits on the person: how many of its tasks, and its newest words when it spoke last. */
export interface GoatBotNeedsYouRow {
  readonly entry: BotRosterEntry;
  readonly name: string;
  readonly count: number;
  readonly ask: { readonly text: string; readonly at: string } | null;
}

/**
 * Every bot with work waiting on the person, the one that spoke most recently first, and how many
 * tasks wait in all. A bot's newest message counts as its ask only when the bot wrote it.
 */
export function goatBotNeedsYou(
  entries: ReadonlyArray<{
    readonly entry: BotRosterEntry;
    readonly name: string;
    readonly status: ChannelGetBotStatusResult | null;
  }>,
): { readonly total: number; readonly rows: ReadonlyArray<GoatBotNeedsYouRow> } {
  const rows: GoatBotNeedsYouRow[] = [];
  for (const { entry, name, status } of entries) {
    if (status === null || status.waitingCount === 0) continue;
    const latest = status.latest;
    rows.push({
      entry,
      name,
      count: status.waitingCount,
      ask:
        latest !== undefined && latest.author === "bot"
          ? { text: latest.text, at: latest.at }
          : null,
    });
  }
  const at = (row: GoatBotNeedsYouRow) =>
    row.ask ? Date.parse(row.ask.at) : Number.NEGATIVE_INFINITY;
  rows.sort((a, b) => at(b) - at(a));
  return { total: rows.reduce((sum, row) => sum + row.count, 0), rows };
}
