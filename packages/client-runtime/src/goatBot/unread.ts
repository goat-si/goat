import type { GoatBotRow } from "./rows.ts";

export function goatBotFirstUnread(rows: ReadonlyArray<GoatBotRow>, lastVisitedAt: string | null) {
  const visitedAt = lastVisitedAt ? Date.parse(lastVisitedAt) : Number.NEGATIVE_INFINITY;
  const unread = rows.filter(
    (row) =>
      (row.kind === "bot" && Date.parse(row.createdAt) > visitedAt) ||
      (row.kind === "task" && Date.parse(row.card.updatedAt) > visitedAt),
  );
  const first = unread[0];
  return first ? { rowId: first.id, count: unread.length } : null;
}
