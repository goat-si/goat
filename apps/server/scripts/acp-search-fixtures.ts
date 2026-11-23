export const fileSearchFixtures = [
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "structured-search-explicit-location",
    title: "Grep",
    kind: "search",
    status: "completed",
    rawInput: { query: "  README.md  " },
    locations: [{ path: "README.md" }],
    rawOutput: "# Title",
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "structured-search-query-only",
    title: "Grep",
    kind: "search",
    status: "completed",
    rawInput: { query: "TODO" },
    rawOutput: "src/a.ts: TODO",
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "structured-search-query-no-output",
    title: "Grep",
    kind: "search",
    status: "completed",
    rawInput: { query: "FIXME" },
  },
] as const;

export const webSearchFixtures = [
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "antigravity-web-search",
    title: "Web search",
    kind: "search",
    status: "completed",
    rawInput: { query: "  top story on Hacker News today  " },
    rawOutput:
      "Sources:\n<https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGYNzfz>.",
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "antigravity-run-search-web",
    title: "Running search_web",
    kind: "search",
    status: "completed",
    rawInput: { query: "top story on Hacker News today" },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "antigravity-web-search-streamed",
    title: "Web search",
    kind: "search",
    status: "in_progress",
    rawInput: { query: "streamed citations" },
    rawOutput: "Sources: https://example.com/streamed_(detail)",
  },
  {
    sessionUpdate: "tool_call_content_chunk",
    toolCallId: "antigravity-web-search-streamed",
    content: { type: "content", content: { type: "text", text: " (updated)" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "antigravity-web-search-streamed",
    status: "completed",
  },
] as const;

export const imageReadFixture = {
  sessionUpdate: "tool_call_update",
  toolCallId: "structured-image-read",
  title: "Read `mockup.png`",
  kind: "read",
  status: "completed",
  rawInput: { file_path: "/workspace/mockup.png", start_line: 0, end_line: 799 },
  rawOutput: "View mockup.png",
} as const;
