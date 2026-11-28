import { ThreadId, type EnvironmentId } from "@goat/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { StackActions, useNavigation } from "@react-navigation/native";
import { createContext, use } from "react";

import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export type ThreadInspectorTarget = {
  readonly type: "thread" | "device";
  readonly environmentId: string;
  readonly threadId: string;
  readonly deviceKey?: string;
};

export const ThreadInspectorNavigationContext = createContext<
  ((target: ThreadInspectorTarget) => void) | null
>(null);

export function useOpenThreadInspector() {
  const navigation = useNavigation();
  const { fileInspector } = useAdaptiveWorkspaceLayout();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (
    source: { readonly environmentId: string; readonly threadId: string },
    target: ThreadInspectorTarget,
  ) => {
    if (!fileInspector.supported) return false;
    if (openInInspector) openInInspector(target);
    else {
      const parent = navigation.getState()?.routes.findLast((route) => route.name === "Thread");
      if (
        !parent?.params ||
        !("environmentId" in parent.params) ||
        parent.params.environmentId !== source.environmentId ||
        !("threadId" in parent.params) ||
        parent.params.threadId !== source.threadId
      )
        return false;
      navigation.dispatch(
        StackActions.popTo("Thread", { ...source, inspector: target }, { merge: true }),
      );
    }
    return true;
  };
}

export function routeThreadIdentity(environmentId: EnvironmentId | null, threadId: string | null) {
  return environmentId === null || threadId === null
    ? null
    : scopedThreadKey(environmentId, ThreadId.make(threadId));
}

export function useReturnToThread() {
  const navigation = useNavigation();
  return (thread: { readonly environmentId: string; readonly threadId: string }) => {
    const params = navigation
      .getState()
      ?.routes.findLast((route) => route.name === "Thread")?.params;
    const same =
      params &&
      "environmentId" in params &&
      params.environmentId === thread.environmentId &&
      "threadId" in params &&
      params.threadId === thread.threadId;
    navigation.dispatch(
      same
        ? StackActions.popTo("Thread", thread, { merge: true })
        : StackActions.replace("Thread", thread),
    );
  };
}
