import { useIsFocused, useNavigation } from "@react-navigation/native";
import { use, useEffect, useMemo } from "react";

import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useProjects } from "../../state/entities";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import {
  pullRequestFallbackEnvironment,
  type PullRequestEnvironmentTarget,
} from "./pullRequestEnvironmentFallback";

export function usePullRequestEnvironmentFallback(params: PullRequestEnvironmentTarget) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const projects = useProjects();
  const isReady = useConnectionsReady();
  const environments = useWorkspaceEnvironments();
  const fallback = useMemo(
    () => (isReady ? pullRequestFallbackEnvironment(params, projects, environments) : null),
    [params, projects, environments, isReady],
  );
  useEffect(() => {
    if (tabActive && focused && fallback) navigation.setParams(fallback);
  }, [fallback, focused, navigation, tabActive]);
}
