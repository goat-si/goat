export function isMissingGitRepository(stderr: string): boolean {
  const diagnostic = stderr.toLowerCase();
  return (
    diagnostic.includes("not a git repository") ||
    diagnostic.includes("gitfile does not point to a valid repository")
  );
}
