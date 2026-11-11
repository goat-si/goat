import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { canForkProjectedAssistantItem } from "@goat/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { useState } from "react";
import { Platform, Pressable, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { FORK_RESPONSE_PICKER, forkChoices, responseForkChoice } from "./threadForkChoices";
import { mobileThreadForkAvailability, threadRunsInCloud, useForkThread } from "./useForkThread";

export function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const sourceThreadId = props.projectedItem.sourceThreadId;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const shell = useThreadShell(scopeThreadRef(props.environmentId, sourceThreadId));
  const project = useProject(shell ? scopeProjectRef(props.environmentId, shell.projectId) : null);
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const { start } = useForkThread();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  const onPress = () => {
    const serverForks = serverConfig?.environment.capabilities.threadForkWorkspace === true;
    const inWorktree = (shell?.worktreePath ?? null) !== null;
    const availability = mobileThreadForkAvailability({
      thread: {
        environmentId: props.environmentId,
        sideChatOf: null,
        latestRunId: runId,
        worktreePath: shell?.worktreePath ?? null,
      },
      forkWorkspaceSupported: serverForks,
      project,
      cloud: shell !== null && threadRunsInCloud(shell, serverConfig?.providers),
    });
    setBusy(true);
    void start(
      {
        environmentId: props.environmentId,
        sourceThreadId,
        sourceTitle: props.sourceTitle,
        runId,
        serverForks,
      },
      responseForkChoice({ availability, isSideChat: shell?.sideChatOf != null }),
      { ...FORK_RESPONSE_PICKER, choices: forkChoices(inWorktree, "response") },
    ).finally(() => setBusy(false));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fork from this response"
      disabled={busy}
      onPress={onPress}
      hitSlop={8}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={props.iconSize}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}
