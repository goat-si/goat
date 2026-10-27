import { useNewTaskFlow } from "./new-task-flow-provider";
import * as Dialog from "../../components/ui/Dialog";
import {
  CommonActions,
  useRoute,
  usePreventRemove,
  usePreventRemoveContext,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  runAtomCommand,
} from "@goat/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { threadSelectionDeferral } from "../layout/deferred-navigation";
import {
  branchCheckoutRequestKey,
  makeNewTaskBranchCheckouts,
  type BranchCheckoutResult,
} from "./new-task-branch-checkout";
import { liveNewTaskFlowKeys, newTaskFlowKey } from "./new-task-flow-state";
import { useWorkspaceState } from "../../state/workspace";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { resolveNewTaskBranchWorktreePath } from "./new-task-context-presentation";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { ThreadScreenFallback } from "./ThreadScreenHost";
import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

import type { NewTaskDraftRouteParams } from "./thread-route-state";
export type { NewTaskDraftRouteParams } from "./thread-route-state";

const branchCheckouts = makeNewTaskBranchCheckouts({
  run: (request) =>
    checkoutNewTaskBranch({
      branch: {
        name: request.branch,
        current: false,
        isDefault: false,
        worktreePath: request.worktreePath,
      },
      project:
        request.environmentId !== null && request.workspaceRoot !== null
          ? { environmentId: request.environmentId, workspaceRoot: request.workspaceRoot }
          : null,
      workspaceMode: "local",
      readRefs: (input) =>
        runAtomCommand(appAtomRegistry, vcsEnvironment.readRefs, input, { reportFailure: false }),
      switchRef: (input) =>
        runAtomCommand(appAtomRegistry, vcsEnvironment.switchRef, input, { reportFailure: false }),
    }),
  holdNavigation: threadSelectionDeferral.waitFor,
  onFailure: (request, result) => {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch branch",
        error instanceof Error ? error.message : "The branch could not be checked out.",
      );
    }
    rootNavigationRef.dispatch({
      ...CommonActions.goBack(),
      source: request.routeKey,
      target: rootNavigationRef.getRootState()?.key,
    });
  },
});

export function pruneNewTaskBranchCheckouts(state: Parameters<typeof liveNewTaskFlowKeys>[0]) {
  branchCheckouts.prune(liveNewTaskFlowKeys(state));
}

const idleBranchCheckoutAtom = Atom.make(AsyncResult.initial<BranchCheckoutResult, never>());

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const currentRoute = useRoute();
  const params = useMemo(() => route.params ?? {}, [route.params]);
  const { reset } = useNewTaskFlow();
  const [initialized, setInitialized] = useState(false);
  useLayoutEffect(() => {
    reset();
    // oxlint-disable-next-line react/set-state-in-effect -- Draft reset runs once before first paint; initialized gates the screen until then.
    setInitialized(true);
  }, [reset]);
  const pendingTaskId = Array.isArray(params.pendingTaskId)
    ? params.pendingTaskId[0]
    : params.pendingTaskId;
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();

  const initialProjectRef = useMemo(
    () => ({
      environmentId: Array.isArray(params.environmentId)
        ? params.environmentId[0]
        : params.environmentId,
      projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
      branch: params.branch,
      worktreePath: params.worktreePath,
      cloning: (Array.isArray(params.cloning) ? params.cloning[0] : params.cloning) === "1",
    }),
    [params],
  );

  const project = projects.find(
    (candidate) =>
      candidate.environmentId === initialProjectRef.environmentId &&
      candidate.id === initialProjectRef.projectId,
  );
  const [resolvedProject, setResolvedProject] = useState<typeof project>(undefined);
  if (
    project &&
    (resolvedProject?.environmentId !== project.environmentId ||
      resolvedProject.workspaceRoot !== project.workspaceRoot)
  ) {
    setResolvedProject(project);
  }
  const flowKey = newTaskFlowKey(currentRoute);
  const previousRequest = branchCheckouts.requestForFlow(flowKey);
  const checkoutProject =
    project ??
    resolvedProject ??
    (previousRequest?.environmentId && previousRequest.workspaceRoot
      ? {
          environmentId: previousRequest.environmentId,
          workspaceRoot: previousRequest.workspaceRoot,
        }
      : undefined);
  const workspaceRoot = checkoutProject?.workspaceRoot;
  const needsPreparation = Boolean(initialProjectRef.branch && !pendingTaskId && !draftId);

  const waitingForProject =
    !project &&
    (catalogState.isLoadingConnections ||
      (!catalogState.hasLoadedShellSnapshot &&
        catalogState.hasConnectingEnvironment &&
        catalogState.connectionError === null));

  const checkoutKey =
    needsPreparation &&
    initialProjectRef.branch &&
    (!waitingForProject || checkoutProject) &&
    flowKey !== undefined
      ? branchCheckoutRequestKey({
          flowKey,
          routeKey: currentRoute.key,
          environmentId: checkoutProject?.environmentId ?? null,
          workspaceRoot: checkoutProject?.workspaceRoot ?? null,
          branch: initialProjectRef.branch,
          worktreePath: initialProjectRef.worktreePath ?? null,
        })
      : null;
  const checkout = useAtomValue(
    checkoutKey === null ? idleBranchCheckoutAtom : branchCheckouts.atom(checkoutKey),
  );
  const result = AsyncResult.isSuccess(checkout) ? checkout.value : null;
  const checkoutPending = needsPreparation && result === null;
  usePreventRemove(checkoutPending, () => undefined);
  const { preventedRoutes } = usePreventRemoveContext();
  const removalBlocked = preventedRoutes[currentRoute.key]?.preventRemove === true;
  useEffect(() => {
    if (checkoutKey === null || checkoutPending || removalBlocked) return;
    branchCheckouts.release(checkoutKey);
  }, [checkoutKey, checkoutPending, removalBlocked]);

  const preparedProjectRef = useMemo(
    () =>
      result?._tag === "Success" && workspaceRoot
        ? {
            ...initialProjectRef,
            branch: result.value.name,
            worktreePath: resolveNewTaskBranchWorktreePath({
              workspaceMode: "local",
              projectCwd: workspaceRoot,
              branchWorktreePath: result.value.worktreePath,
            }),
          }
        : initialProjectRef,
    [initialProjectRef, result, workspaceRoot],
  );
  const preparingBranch = checkoutPending || (needsPreparation && result?._tag !== "Success");

  if (!initialized) return null;
  return (
    <>
      {preparingBranch ? (
        <ThreadScreenFallback>
          <NativeStackScreenOptions options={{ title: "New thread" }} />
          <View className="flex-1 items-center justify-center bg-screen">
            <Text className="text-foreground">Switching branch...</Text>
          </View>
        </ThreadScreenFallback>
      ) : (
        <NewTaskDraftScreen
          initialProjectRef={preparedProjectRef}
          incomingShareId={
            Array.isArray(params.incomingShareId)
              ? params.incomingShareId[0]
              : params.incomingShareId
          }
          pendingTaskId={pendingTaskId}
          draftId={draftId}
        />
      )}
    </>
  );
}
