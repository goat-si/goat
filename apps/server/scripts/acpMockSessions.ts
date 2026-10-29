export const mockSessionPage = (
  cwd: string,
  sessionId: string,
  count: number,
  scenario: string | undefined,
) => ({
  sessions: Array.from({ length: count }, (_, index) => ({
    sessionId:
      index !== 0
        ? `mock-session-${index + 1}`
        : scenario === "id-whitespace"
          ? ` ${sessionId} `
          : scenario === "id-oversized"
            ? "x".repeat(1_025)
            : sessionId,
    cwd:
      index !== 0
        ? cwd
        : scenario === "cwd-whitespace"
          ? ` ${cwd} `
          : scenario === "cwd-oversized"
            ? "/" + "x".repeat(4_096)
            : cwd,
    title: "Mock session",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...(index !== 0
      ? {}
      : scenario === "dirs-over-32"
        ? { additionalDirectories: Array.from({ length: 33 }, (_, dir) => `${cwd}/extra-${dir}`) }
        : scenario === "dir-whitespace"
          ? { additionalDirectories: [`${cwd}/extra`, ` ${cwd}/padded `] }
          : scenario === "dirs-kept"
            ? { additionalDirectories: [`${cwd}/extra`] }
            : {}),
  })),
  ...(scenario === "cursor-unchanged"
    ? { nextCursor: "next-page" }
    : scenario === "cursor-whitespace"
      ? { nextCursor: " next-page " }
      : scenario === "cursor-oversized"
        ? { nextCursor: "x".repeat(2_049) }
        : scenario === "cursor-blank"
          ? { nextCursor: "  " }
          : count > 256
            ? { nextCursor: "after-page" }
            : {}),
});
