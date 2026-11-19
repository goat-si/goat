export function gitHubOwnerHeadSelector(
  kind: string,
  full: boolean,
  head: { readonly headBranch: string; readonly headRepositoryOwnerLogin: string | null },
): string | undefined {
  return full && kind === "github" && head.headRepositoryOwnerLogin
    ? `${head.headRepositoryOwnerLogin}:${head.headBranch}`
    : undefined;
}
