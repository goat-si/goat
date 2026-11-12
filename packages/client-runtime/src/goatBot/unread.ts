import type { GoatBotRow } from "./rows.ts";

/** The bot messages and work cards that are newer than the person's last visit. */
export function goatBotUnreadIds(
  rows: ReadonlyArray<GoatBotRow>,
  lastVisitedAt: string | null,
): ReadonlySet<string> {
  const visitedAt = lastVisitedAt ? Date.parse(lastVisitedAt) : Number.NEGATIVE_INFINITY;
  return new Set(
    rows
      .filter(
        (row) =>
          (row.kind === "bot" && Date.parse(row.createdAt) > visitedAt) ||
          (row.kind === "task" && Date.parse(row.card.updatedAt) > visitedAt),
      )
      .map((row) => row.id),
  );
}
