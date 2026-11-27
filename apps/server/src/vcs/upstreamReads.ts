import type { GitRemoteStatusDetails } from "./GitVcsDriver.ts";

export const makeUpstreamReads = () => {
  const reads = new Map<string, GitRemoteStatusDetails>();
  return {
    clear: (cwd: string) => {
      reads.delete(cwd);
    },
    remember: (cwd: string, details: GitRemoteStatusDetails) => {
      reads.delete(cwd);
      if (reads.size >= 2048) {
        const oldest = reads.keys().next().value;
        if (oldest !== undefined) reads.delete(oldest);
      }
      reads.set(cwd, details);
    },
    take: (cwd: string) => {
      const details = reads.get(cwd);
      reads.delete(cwd);
      return details;
    },
  };
};
