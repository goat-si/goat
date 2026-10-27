export const mockSessionNotices = [
  {
    _meta: { isReplay: true },
    update: { sessionUpdate: "notice", severity: "info", title: "Replayed announcement" },
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
  { update: { sessionUpdate: "notice", severity: "info", title: " \n\t " } },
];
