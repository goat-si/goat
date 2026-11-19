import type { EnvironmentId, PullRequestProviderSummary } from "@goat/contracts";
import { useState } from "react";

import {
  rememberPullRequestHosts,
  resetPullRequestHosts,
  type PullRequestHostRead,
} from "./pullRequestProjectAssignment.logic";

type HostObservations = ReadonlyArray<
  readonly [
    EnvironmentId,
    { readonly providers: ReadonlyArray<PullRequestProviderSummary> },
    number,
  ]
>;

/**
 * Which hosts each environment's last list could read, so a repository several environments hold
 * is read through one that can. A refresh forgets it, so the preferred environments get asked again.
 */
export function usePullRequestHostReads() {
  const [hostReads, setHostReads] = useState<ReadonlyMap<EnvironmentId, PullRequestHostRead>>(
    () => new Map(),
  );
  return {
    hostReads,
    /** Folds in what the lists answered; only a changed reading re-renders the page. */
    observe: (...observations: ReadonlyArray<HostObservations>) => {
      const next = observations.reduce(rememberPullRequestHosts, hostReads);
      if (next !== hostReads) setHostReads(next);
    },
    reset: () => setHostReads(resetPullRequestHosts),
  };
}
