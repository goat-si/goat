import { type EnvironmentId, type EnvironmentMachineKind } from "@goat/contracts";
import { FolderIcon, ListFilterIcon, SettingsIcon } from "~/components/solar";
import {
  useReducer,
  useRef,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "../Sidebar.logic";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarProjectScope(props: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly scopedProjectGroups: readonly SidebarProjectSnapshot[];
  readonly projectScopeKeys: readonly string[];
  readonly setProjectScopeKeys: (keys: readonly string[]) => void;
  readonly openProjectSettings: (project: SidebarProjectSnapshot) => void;
  readonly showProjectEnvironments: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly headerSearchRef: RefObject<HTMLDivElement | null>;
}) {
  const {
    projectGroups,
    scopedProjectGroups,
    projectScopeKeys,
    setProjectScopeKeys,
    openProjectSettings,
    showProjectEnvironments,
    primaryEnvironmentId,
    environmentMachineById,
    headerSearchRef,
  } = props;
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  // Safari may click after Ctrl+click opens settings; suppress that selection until reopening.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...projectGroups.map((project) => ({ value: project.projectKey, label: project.displayName })),
  ];
  const selectedProjectScopeItem =
    projectScopeKeys.length > 1
      ? null
      : (projectScopeItems.find((item) => item.value === (projectScopeKeys[0] ?? "all")) ??
        projectScopeItems[0] ??
        null);
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroup = scopedProjectGroups.length === 1 ? scopedProjectGroups[0] : null;
  const toggleProjectScopeKey = (key: string) =>
    setProjectScopeKeys(
      projectScopeKeys.includes(key)
        ? projectScopeKeys.filter((candidate) => candidate !== key)
        : [...projectScopeKeys, key],
    );
  const handleProjectSettings = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
    projectGroup: SidebarProjectSnapshot,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    suppressNextScopeChangeRef.current = true;
    dispatchProjectScopeMenu({ type: "project-settings-opened" });
    openProjectSettings(projectGroup);
  };
  return (
    <Combobox
      items={projectScopeItems}
      filteredItems={filteredProjectScopeItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectScopeMenuState.open}
      onOpenChange={(open, eventDetails) => {
        if (eventDetails.isCanceled) return;
        if (open) suppressNextScopeChangeRef.current = false;
        dispatchProjectScopeMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedProjectScopeKeyRef.current = item?.value ?? null;
      }}
      value={selectedProjectScopeItem}
      onValueChange={(item, eventDetails) => {
        if (suppressNextScopeChangeRef.current) {
          suppressNextScopeChangeRef.current = false;
          return;
        }
        if (!item) return;
        if (item.value === "all") setProjectScopeKeys([]);
        else if (eventDetails.event instanceof MouseEvent && eventDetails.event.shiftKey) {
          eventDetails.cancel();
          toggleProjectScopeKey(item.value);
        } else setProjectScopeKeys([item.value]);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={
              scopedProjectGroups.length
                ? `Filter threads by project: ${scopedProjectGroups.map((project) => project.displayName).join(", ")}`
                : "Filter threads by project"
            }
          />
        }
      >
        {scopedProjectGroups.length > 1 ? (
          <span className="flex shrink-0 -space-x-1.5">
            {scopedProjectGroups.slice(0, 2).map((project) => (
              <ProjectFavicon key={project.projectKey} project={project} className="size-3.5" />
            ))}
          </span>
        ) : scopedProjectGroup ? (
          // Wrapped so the button's direct-child svg color rule cannot override
          // a project's own icon color.
          <span className="flex shrink-0">
            <ProjectFavicon project={scopedProjectGroup} className="size-4" />
          </span>
        ) : (
          <ListFilterIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        // Anchored to the search field, not the 28px trigger: the
        // popup opens under the field, is at least as wide as it,
        // and grows to fit project names up to a cap, past which
        // the rows truncate.
        anchor={headerSearchRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={projectScopeMenuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey
            ) {
              return;
            }
            // Combobox items use virtual focus: keyboard events
            // stay on this input, not on the highlighted option.
            const scopeKey = highlightedProjectScopeKeyRef.current;
            const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
            if (event.shiftKey && event.key === "Enter") {
              if (project) {
                event.preventDefault();
                toggleProjectScopeKey(project.projectKey);
              }
              return;
            }
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            if (project) handleProjectSettings(event, project);
          }}
          onChange={(event) =>
            dispatchProjectScopeMenu({
              type: "query-changed",
              query: event.target.value,
            })
          }
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList aria-multiselectable>
          {(item: (typeof projectScopeItems)[number]) => {
            const project = projectGroupByScopeKey.get(item.value) ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                aria-selected={
                  project ? projectScopeKeys.includes(item.value) : projectScopeKeys.length === 0
                }
                data-selected={undefined}
                onContextMenu={(event) => {
                  if (project) handleProjectSettings(event, project);
                }}
              >
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {(
                  project ? projectScopeKeys.includes(item.value) : projectScopeKeys.length === 0
                ) ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
                {project && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {project ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      void handleProjectSettings(event, project);
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
