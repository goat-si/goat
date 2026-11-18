export const openCodeUpdateCases = [
  {
    mode: "default-precurrent",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "default",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted-current",
    version: "1.14.20",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "unknown",
    version: "1.14.19",
    installation: { installedVersion: null },
    status: "unchanged",
  },
  { mode: "legacy", version: "1.14.20", installation: {}, status: "succeeded" },
] as const;
