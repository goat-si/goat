import {
  repositoryGroupingKeyOf,
  type MemoryListInput,
  type MemoryPage,
  type MemoryProjectBinding,
  type MemoryScope,
  type MemorySearchInput,
  type RepositoryIdentity,
} from "@goat/contracts";

// Indexed phrase search works at every supported scope size, unlike bounded substring scans.
const MEMORY_SEARCH_MODE = "fts" satisfies MemorySearchInput["mode"];

/** Call only after binding lookup succeeds: a failed lookup cannot rule out an explicit key. */
export function memoryProjectScope(
  binding: Pick<MemoryProjectBinding, "projectKey" | "repositoryKey">,
  repositoryIdentity: RepositoryIdentity | null | undefined,
): MemoryScope | null {
  const projectKey =
    binding.projectKey ??
    binding.repositoryKey ??
    (repositoryIdentity
      ? { kind: "repository" as const, groupingKey: repositoryGroupingKeyOf(repositoryIdentity) }
      : null);
  return projectKey ? { kind: "project", projectKey } : null;
}

type BrowseInput = Omit<MemoryListInput, "includeQuarantined">;

export function memoryBrowseInput(input: BrowseInput) {
  return { ...input, scope: input.scope ?? { kind: "user" as const } };
}

export function memorySearchInput(input: BrowseInput, query: string): MemorySearchInput {
  return { ...memoryBrowseInput(input), query: query.trim(), mode: MEMORY_SEARCH_MODE };
}

export function presentMemoryPage(page: MemoryPage, searching: boolean) {
  if (searching && page.indexCoverage && page.indexCoverage.status !== "available") {
    return "Results are incomplete; memories may still be available";
  }
  if (page.items.length > 0) return null;
  if (page.nextCursor) return "No matching memories on this page. Continue to the next page.";
  return searching ? "No memories found" : "No memories yet.";
}

export function memoryPreview(text: string) {
  let preview = "";
  let length = 0;
  for (const character of text) {
    if (length++ === 120) break;
    preview += character;
  }
  return preview;
}

export function memoryScopeLabel(scope: MemoryScope) {
  return scope.kind === "user" ? "User" : scope.kind === "project" ? "Project" : "Thread";
}
