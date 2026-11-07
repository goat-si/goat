export const launchAlternateTarget = (args: unknown): [string, unknown] | undefined => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return Object.entries(args).find(([key]) => key !== "bundle_id" && key !== "session");
};
