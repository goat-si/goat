export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) continue;
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

export function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) return null;
  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) return null;
  return { upstreamRef, remoteName, branchName };
}

export function parseTrackingBranchByUpstreamRef(
  stdout: string,
  upstreamRef: string,
): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) continue;
    if (candidateUpstreamRef === upstreamRef) return branchName;
  }
  return null;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) return null;
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}
// Fetch stderr can carry credentials; persist only fixed diagnoses or generic failures.
export function fetchFailureDetail(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  if (
    lines.some((line) =>
      /^(?:fatal: (?:Authentication failed|could not read (?:Username|Password))\b|\S+: Permission denied \(publickey)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  }
  if (
    lines.some((line) =>
      /^(?:(?:fatal: |ssh: )?Could not resolve host(?:name)?\b|fatal: unable to access .+: (?:Could not resolve host|Failed to connect)\b|ssh: connect to host \S+ port \d+: (?:Connection timed out|Connection refused|Network is unreachable)\b)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not reach the remote. Check the server's network connection and remote host, then retry.";
  }
  if (
    lines.some((line) =>
      /^(?:remote: Repository not found\.?$|fatal: repository .+ not found$|fatal: .+ does not appear to be a git repository$)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not access the remote repository. Check the remote URL and repository permissions on the server.";
  }
  if (isRefLockFailure(stderr))
    return "Git could not update a local reference. Another Git operation or a stale lock may be blocking the fetch; check the repository on the server, then retry.";
  return undefined;
}

// Git 2.53+ reports ref races as fetching-ref failures; older versions say cannot lock ref.
export function isRefLockFailure(stderr: string): boolean {
  return stderr
    .split(/\r?\n/)
    .some((line) =>
      /^(?:(?:error|fatal): cannot lock ref\b|fatal: Unable to create ['"].+\.lock['"]:|error: fetching ref \S+ failed: (?:incorrect old value provided|reference already exists)$)/i.test(
        line.trim(),
      ),
    );
}
export function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}
export function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return { ahead: Number(match[1] ?? "0"), behind: Number(match[2] ?? "0") };
}
