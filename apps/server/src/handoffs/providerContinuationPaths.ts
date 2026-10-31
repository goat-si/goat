/** Provider approvals whose approval the server applies, keeping their arguments until it does. */
export const PROVIDER_CONTINUATION_PATHS = [
  "provider.home_request",
  "provider.host_sync",
  "provider.settings",
  "provider.setup",
] as const;
export type ProviderContinuationPath = (typeof PROVIDER_CONTINUATION_PATHS)[number];
export const isProviderContinuationPath = (path: string): path is ProviderContinuationPath =>
  (PROVIDER_CONTINUATION_PATHS as ReadonlyArray<string>).includes(path);
