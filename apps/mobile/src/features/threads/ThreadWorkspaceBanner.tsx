import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadWorkspaceState } from "@goat/contracts";
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
  const status = useAtomValue(query);
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const state: ThreadWorkspaceState | undefined =
    status._tag === "Success" ? status.value.state : undefined;
  if (restored || (state !== "cleaned" && state !== "missing")) return null;
  const run = async (mode: "restore" | "fresh") => {
    setBusy(true);
    setError(null);
    const result = await restore({ environmentId, input: { threadId, mode } });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    setRestored(true);
    appAtomRegistry.refresh(query);
  };
  return (
    <View className="mx-4 mb-3 gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-goat-medium text-sm text-foreground">
        {state === "cleaned" ? "This worktree was cleaned up." : "This worktree is missing."}
      </Text>
      <Text className="text-xs text-foreground-muted">Sending a message also restores it.</Text>
      {error ? (
        <Text selectable className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label={state === "cleaned" ? "Restore" : "Recreate"}
        disabled={busy}
        onPress={() => void run("restore")}
      />
      {error ? (
        <Button label="Start in a new worktree" disabled={busy} onPress={() => void run("fresh")} />
      ) : null}
    </View>
  );
}
