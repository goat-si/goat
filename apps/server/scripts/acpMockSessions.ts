export const mockSessionPage = (
  cwd: string,
  sessionId: string,
  count: number,
  cursor: string | null | undefined,
) => {
  if (cursor === "after-page" || cursor === "legacy-cursor") {
    return {
      sessions: [
        { sessionId: cursor === "after-page" ? "next-page-session" : "legacy-page-session", cwd },
      ],
    };
  }
  return {
    sessions: Array.from({ length: count }, (_, index) => ({
      sessionId: index === 0 ? sessionId : `mock-session-${index + 1}`,
      cwd,
      title: "Mock session",
      updatedAt: "1970-01-01T00:00:00.000Z",
    })),
    ...(cursor === "oversized-cursor"
      ? { nextCursor: "x".repeat(2_048) }
      : count > 256
        ? { nextCursor: "after-page" }
        : {}),
  };
};
