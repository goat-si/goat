import type { ComponentProps } from "react";
import { sortProjectsByGroupOrder } from "@goat/client-runtime/state/project-grouping";
import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import { PullRequestFiltersMenu } from "./PullRequestListFilters";

export function PullRequestFiltersMenuInSidebarOrder(
  props: ComponentProps<typeof PullRequestFiltersMenu>,
) {
  const sidebarProjectGroups = useSidebarProjectGroups();
  const projects = sortProjectsByGroupOrder(props.projects, sidebarProjectGroups);
  return <PullRequestFiltersMenu {...props} projects={projects} />;
}
