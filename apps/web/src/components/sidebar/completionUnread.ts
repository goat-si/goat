export function hasUnseenCompletion(thread: {
  readonly latestRun?: { readonly completedAt: string | null } | null | undefined;
  readonly notificationCompletedAt?: string | null | undefined;
  readonly markedUnreadCompletionAt?: string | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  const automatic =
    thread.notificationCompletedAt === undefined
      ? thread.latestRun?.completedAt
      : thread.notificationCompletedAt;
  const times = [automatic, thread.markedUnreadCompletionAt]
    .map((at) => Date.parse(at ?? ""))
    .filter(Number.isFinite);
  if (times.length === 0 || !thread.lastVisitedAt) return false;
  const visited = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(visited) || Math.max(...times) > visited;
}
