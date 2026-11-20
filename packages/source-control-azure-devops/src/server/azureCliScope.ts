type Scope = {
  readonly organization: string;
  readonly project: string;
  readonly repository: string;
};

export function azureScopeFromRemote(remote: string, allowSelfHosted = false): Scope | null {
  try {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(remote);
    const url = new URL(
      remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote,
    );
    if (url.search || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (
      !allowSelfHosted &&
      host !== "dev.azure.com" &&
      !host.endsWith(".dev.azure.com") &&
      !host.endsWith(".visualstudio.com")
    )
      return null;
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    let organization: string;
    let project: string | undefined;
    let repository: string | undefined;
    if (
      url.protocol === "ssh:" &&
      (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com")
    ) {
      if (parts.length !== 4 || parts[0] !== "v3") return null;
      const org = parts[1];
      if (!org) return null;
      if (
        host === "vs-ssh.visualstudio.com" &&
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(org)
      )
        return null;
      organization =
        host === "vs-ssh.visualstudio.com"
          ? `https://${org}.visualstudio.com`
          : `https://dev.azure.com/${encodeURIComponent(org)}`;
      [project, repository] = parts.slice(2);
    } else if (url.protocol === "https:" || url.protocol === "http:") {
      const marker = parts.lastIndexOf("_git");
      if (marker < (host.endsWith(".visualstudio.com") ? 1 : 2) || marker !== parts.length - 2)
        return null;
      project = parts[marker - 1];
      repository = parts[marker + 1];
      const prefix = parts.slice(0, marker - 1);
      if (host === "dev.azure.com" && prefix.length !== 1) return null;
      if (host.endsWith(".visualstudio.com")) {
        organization = url.origin;
      } else {
        if (prefix.length === 0) return null;
        organization = `${url.origin}/${prefix.map(encodeURIComponent).join("/")}`;
      }
    } else return null;
    if (
      !project ||
      !repository ||
      [project, repository].some((part) => /^[@-]|[\p{Cc}/\\]/u.test(part))
    )
      return null;
    return { organization, project, repository };
  } catch {
    return null;
  }
}

const hasOption = (args: ReadonlyArray<string>, pattern: RegExp) =>
  args.some((arg) => pattern.test(arg));

export function azureCliNeedsScope(args: ReadonlyArray<string>): boolean {
  const detect = args.indexOf("--detect");
  return (
    detect >= 0 &&
    args[detect + 1] === "true" &&
    !hasOption(args, /^(?:--organization|--org)(?:=|$)/u)
  );
}

export function scopeAzureCliArgs(
  args: ReadonlyArray<string>,
  remoteUrl: string | null,
  allowSelfHosted = false,
): ReadonlyArray<string> {
  const detect = args.indexOf("--detect");
  if (!azureCliNeedsScope(args)) return args;
  const scope = remoteUrl === null ? null : azureScopeFromRemote(remoteUrl, allowSelfHosted);
  if (!scope) return args;
  const scoped = [...args, "--organization", scope.organization];
  scoped[detect + 1] = "false";
  const acceptsProject =
    args[0] === "repos" &&
    (args[1] === "show" ||
      args[1] === "create" ||
      (args[1] === "pr" && (args[2] === "list" || args[2] === "create")));
  if (!acceptsProject) return scoped;
  if (!hasOption(args, /^(?:--project|-p)(?:=|$)/u)) scoped.push(`--project=${scope.project}`);
  if (args[1] !== "create" && !hasOption(args, /^(?:--repository|-r)(?:=|$)/u))
    scoped.push(`--repository=${scope.repository}`);
  return scoped;
}
