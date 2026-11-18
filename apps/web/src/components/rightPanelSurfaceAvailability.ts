export const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the GOAT desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  device: "Devices are only available from a thread.",
} as const;

export const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "No pull request on this branch yet.",
  pullRequests: "No linked pull requests available.",
  device: "Available from a thread.",
} as const;
