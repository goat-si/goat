import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  describeThreadWorkspaceRecovery,
  describeThreadWorkspaceRestore,
  type EnvironmentId,
  type ThreadId,
} from "@goat/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadWorkspaceBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = serverEnvironment.threadWorkspaceStatus({ environmentId, input: { threadId } });
  const result = useAtomValue(query);
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restore" | "fresh" | null>(null);
  const [outcome, setOutcome] = useState<{ summary: string; lost: string | null } | null>(null);
  const status = result._tag === "Success" ? result.value : undefined;
  if (outcome !== null)
    return (
      <View className="mx-4 mb-3 gap-2 rounded-[20px] border border-border bg-card-alt p-4">
        <Text className="font-goat-medium text-sm text-foreground">{outcome.summary}</Text>
        {outcome.lost === null ? null : (
          <Text className="text-xs text-foreground-muted">{outcome.lost}</Text>
        )}
        <Button label="Dismiss" tone="text" onPress={() => setOutcome(null)} />
      </View>
    );
  const setupOnly = status?.state === "present" && status.setupIncomplete === true;
  if (
    status === undefined ||
    (!setupOnly && status.state !== "cleaned" && status.state !== "missing")
  )
    return null;
  const run = async (mode: "restore" | "fresh") => {
    setBusy(mode);
    setError(null);
    const answer = await restore({ environmentId, input: { threadId, mode } });
    setBusy(null);
    if (answer._tag === "Failure") {
      const failure = squashAtomCommandFailure(answer);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    setOutcome(
      describeThreadWorkspaceRestore({
        ...answer.value,
        ...(status.branch === null ? {} : { previousBranch: status.branch }),
      }),
    );
    appAtomRegistry.refresh(query);
  };
  const recovery =
    status.state === "cleaned" || status.state === "missing"
      ? describeThreadWorkspaceRecovery({ ...status, state: status.state })
      : null;
  const [title, body] =
    setupOnly || recovery === null
      ? [
          "This worktree was recreated, but its setup did not finish.",
          "GOAT runs setup again before the next turn. You can also run it now.",
        ]
      : status.state === "cleaned"
        ? ["This worktree was cleaned up to save space.", recovery.body]
        : ["This worktree's folder is missing.", recovery.body];
  return (
    <View className="mx-4 mb-3 gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-goat-medium text-sm text-foreground">{title}</Text>
      <Text className="text-xs text-foreground-muted">{body}</Text>
      {error ? (
        <Text selectable className="text-danger-foreground">
          {error} Start in a new worktree to keep working; the branch and any snapshot stay.
        </Text>
      ) : null}
      {recovery === null || recovery.inPlace ? (
        <Button
          label={setupOnly ? "Run setup now" : status.state === "cleaned" ? "Restore" : "Recreate"}
          loading={busy === "restore"}
          disabled={busy !== null}
          onPress={() => void run("restore")}
        />
      ) : null}
      {setupOnly ? null : (
        <Button
          label="Start in a new worktree"
          tone="secondary"
          loading={busy === "fresh"}
          disabled={busy !== null}
          onPress={() => void run("fresh")}
        />
      )}
    </View>
  );
}
