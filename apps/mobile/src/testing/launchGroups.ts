// oxlint-disable goat/no-hookless-use-function -- Test stand-ins keep the real hook names.
import type { useThreadListV2LaunchGroups as Groups } from "../features/threads/use-thread-list-v2-launch-groups";

/** Launch group expansion for screen tests that do not exercise it: nothing expanded, nothing saved. */
export const useThreadListV2LaunchGroups = (): ReturnType<typeof Groups> => ({
  loaded: false,
  state: { expanded: {}, showAll: new Set(), routeCollapsed: new Set() },
  toggle: () => {},
  showAll: () => {},
  reveal: () => {},
});

export const useRevealLaunchGroups = () => {};
