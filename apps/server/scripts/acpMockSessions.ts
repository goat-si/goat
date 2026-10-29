export const mockSessionPage = (cwd: string, sessionId: string, count: number) => ({
  sessions: Array.from({ length: count }, (_, index) => ({
    sessionId: index === 0 ? sessionId : `mock-session-${index + 1}`,
    cwd,
    title: "Mock session",
    updatedAt: "1970-01-01T00:00:00.000Z",
  })),
  ...(count > 256 ? { nextCursor: "after-page" } : {}),
});
