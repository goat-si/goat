export const mockSessionNotices = [
  {
    _meta: { isReplay: true },
    update: { sessionUpdate: "notice", severity: "info", title: "Replayed announcement" },
  },
  {
    _meta: { isReplay: true },
    update: { sessionUpdate: "notice", severity: "info" },
  },
  {
    _meta: { isReplay: true },
    update: { sessionUpdate: "notice", severity: "info", title: 42 },
  },
  {
    _meta: { isReplay: true },
    update: { sessionUpdate: "notice", severity: 42, title: "Wrong severity type" },
  },
  {
    update: {
      sessionUpdate: "notice",
      severity: "info",
      title: "skill discovery warning: candidate was skipped because its metadata is invalid",
    },
  },
  {
    update: {
      sessionUpdate: "notice",
      severity: "warning",
      title: "Optional integration unavailable",
      description: "Continuing without the integration.",
    },
  },
  {
    update: {
      sessionUpdate: "notice",
      severity: "future-severity",
      title: "Future announcement",
    },
  },
  { update: { sessionUpdate: "notice", severity: "info", title: " \n\t " } },
];
