import type * as GitVcsDriver from "./GitVcsDriver.ts";

export interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | null | undefined;
  stallTimeoutMs?: number | undefined;
  forceKillAfterMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  keepLineCallbacksAfterTruncation?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
  writesSharedConfig?: boolean | undefined;
  retryConfigLock?: boolean | undefined;
}
