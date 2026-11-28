import type { VcsStatusLocalResult, VcsStatusRemoteResult } from "@goat/contracts";

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

export interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
}

interface CachedLocalStatus extends CachedValue<VcsStatusLocalResult> {
  readonly includesBranchChanges: boolean;
}

export interface CachedVcsStatus {
  readonly local: CachedLocalStatus | null;
  readonly remote: CachedRemoteStatus | null;
}

export function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}
