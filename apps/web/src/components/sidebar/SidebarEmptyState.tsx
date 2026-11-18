import { PlusIcon } from "~/components/solar";

export function SidebarEmptyState(props: {
  hasProjects: boolean;
  scopeCount: number;
  scopeName: string | undefined;
  hasSettled: boolean;
  onAddProject: () => void;
  onShowAll: () => void;
}) {
  const buttonClass =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground";
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
      {!props.hasProjects ? (
        <>
          <span>No projects yet</span>
          <button type="button" onClick={props.onAddProject} className={buttonClass}>
            <PlusIcon className="-mx-0.5 size-3" /> Add project
          </button>
        </>
      ) : props.scopeCount > 0 ? (
        <>
          <span>{`No ${props.hasSettled ? "active threads" : "threads"} in ${props.scopeCount > 1 ? "these projects" : props.scopeName}${props.hasSettled ? "" : " yet"}`}</span>
          <button type="button" onClick={props.onShowAll} className={buttonClass}>
            Show all projects
          </button>
        </>
      ) : (
        "No threads yet"
      )}
    </div>
  );
}
