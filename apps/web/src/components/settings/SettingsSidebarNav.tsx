import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  InboxIcon,
  BrainIcon,
  BlocksIcon,
  BotIcon,
  SnapShotIcon,
  CalendarClockIcon,
  GitBranchIcon,
  HardDriveIcon,
  FolderWithFilesIcon,
  KeyboardIcon,
  MessageCircleIcon,
  PlugIcon,
  PaletteIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  XIcon,
} from "~/components/solar";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
  SidebarInput,
} from "../ui/sidebar";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { registerSettingsSearchInput } from "./SettingsSearchShortcut";
import { scrollToSettingsTarget } from "./settingsLayout";
import { SETTINGS_NAV_GROUPS } from "./settingsNav";
import {
  searchSettings,
  isSettingsOverviewVisible,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";

const GoatConnectSidebarSignIn = lazy(() =>
  import("../clerk/GoatConnectSidebarSignIn").then((module) => ({
    default: module.GoatConnectSidebarSignIn,
  })),
);
const GoatConnectSidebarAvatar = lazy(() =>
  import("../clerk/GoatConnectSidebarSignIn").then((module) => ({
    default: module.GoatConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/memory": BrainIcon,
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": FolderWithFilesIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/goat-bot": MessageCircleIcon,
  "/settings/decision-inbox": InboxIcon,
  "/settings/hub": ServerIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/connections": PlugIcon,
  "/settings/archived": ArchiveIcon,
};

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="size-3.5 h-5 shrink-0 text-sidebar-muted-foreground/60" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = validateSettingsScopeSearch(currentSearch);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  const isNavItemVisible = (to: SettingsPath) =>
    (to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch)) &&
    (to !== "/settings/memory" || searchableItems.some((entry) => entry.to === to));
  const navGroups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    paths: group.paths.filter(isNavItemVisible),
  })).filter((group) => group.paths.length > 0);
  const { isMobile, setOpenMobile } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = searchSettings(query, searchableItems);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  const handleSectionClick = (to: SettingsPath) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({
      to,
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    if (isMobile) {
      setOpenMobile(false);
    }
    const targetId = item.targetId ?? item.id;
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              <SidebarInput
                ref={(input) => {
                  searchInputRef.current = input;
                  registerSettingsSearchInput(input);
                }}
                nativeInput
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "Settings search results" : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem key={item.id} role="presentation">
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {SETTINGS_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <nav aria-label="Settings sections" className="flex flex-col gap-3">
                {navGroups.map((group, groupIndex) => {
                  const headingId = `settings-nav-group-${groupIndex}`;
                  return (
                    <div key={group.label} className="flex flex-col gap-0.5">
                      <h2
                        id={headingId}
                        className="px-2 py-1 text-xs font-medium text-sidebar-muted-foreground/70"
                      >
                        {group.label}
                      </h2>
                      <SidebarMenu aria-labelledby={headingId}>
                        {group.paths.map((to) => {
                          const Icon = SETTINGS_SECTION_ICONS[to];
                          const isGeneralDetailPage =
                            to === "/settings/general" &&
                            pathname === "/settings/open-source-licenses";
                          const isActive =
                            isGeneralDetailPage || pathname === to || pathname.startsWith(`${to}/`);
                          return (
                            <SidebarMenuItem key={to}>
                              <SidebarMenuButton
                                isActive={isActive}
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => handleSectionClick(to)}
                              >
                                <Icon />
                                <span className="truncate">{SETTINGS_SECTION_LABELS[to]}</span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  );
                })}
              </nav>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {hasCloudPublicConfig() ? (
          <Suspense fallback={null}>
            <GoatConnectSidebarSignIn />
          </Suspense>
        ) : null}
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarUtilityMenu />
          </div>
          {hasCloudPublicConfig() ? (
            <Suspense fallback={null}>
              <GoatConnectSidebarAvatar />
            </Suspense>
          ) : null}
        </div>
      </SidebarFooter>
    </>
  );
}
