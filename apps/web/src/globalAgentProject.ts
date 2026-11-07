import { sortScopedProjectsForSidebar } from "./components/Sidebar.logic";

export function selectMostRecentOpenProject<
  TProject extends Parameters<typeof sortScopedProjectsForSidebar>[0][number] & {
    readonly archivedAt?: string | null | undefined;
  },
  TThread extends Parameters<typeof sortScopedProjectsForSidebar>[1][number],
>(projects: readonly TProject[], threads: readonly TThread[]): TProject | null {
  return (
    sortScopedProjectsForSidebar(
      projects.filter((project) => project.archivedAt == null),
      threads,
      "updated_at",
    )[0] ?? null
  );
}
