const notice = {
  sessionUpdate: "notice",
  severity: "warning",
  title: "MCP server unavailable",
  description: "Continuing without it.",
} as const;
const futureSeverity = {
  sessionUpdate: "notice",
  severity: "future-severity",
  title: "Provider announcement",
  description: null,
  _meta: { source: "mock" },
} as const;
const malformed = [
  { sessionUpdate: "notice", severity: "info" },
  { sessionUpdate: "notice", severity: "info", title: "" },
  { sessionUpdate: "notice", severity: "info", title: 42 },
  { sessionUpdate: "notice", title: "Missing severity" },
  { sessionUpdate: "notice", severity: 42, title: "Wrong severity type" },
  { sessionUpdate: "notice", severity: "info", title: "Bad description", description: {} },
  { sessionUpdate: "notice", severity: "info", title: "Bad metadata", _meta: "invalid" },
];
export const noticeUpdates = [notice, futureSeverity, ...malformed];
export const expectedNoticeUpdates = [
  notice,
  futureSeverity,
  ...malformed.map((raw) => ({
    sessionUpdate: "_t3_unknown",
    originalSessionUpdate: "notice",
    raw,
  })),
];
