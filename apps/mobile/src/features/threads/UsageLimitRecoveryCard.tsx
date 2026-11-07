import { Button } from "../../components/ui/Button";
import { limitRecoveryOwnsSnooze } from "@goat/client-runtime/state/thread-execution";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { EnvironmentId } from "@goat/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_URL,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
} from "@goat/shared/usageLimits";
import * as Clipboard from "expo-clipboard";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Linking, View } from "react-native";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { useDeadlinePassed } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [status, setStatus] = useState<"copied" | "copy-failed" | "open-failed" | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    thread.settledOverride !== "settled" &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  const code = thread.runtime?.lastErrorCode;
  const workspaceLimit = code === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || code === CHATGPT_USAGE_LIMIT_CODE;
  if (
    thread.runtime?.status !== "failed" ||
    (thread.runtime.lastErrorClass !== "usage_limit" && !chatGptLimit) ||
    (!runId && !chatGptLimit)
  )
    return null;
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil: thread.snoozedUntil }) &&
    !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        limitRecovery: {
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        },
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
  }
  return (
    <View
      accessibilityRole={chatGptLimit ? "alert" : undefined}
      className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3"
    >
      {chatGptLimit ? (
        <>
          <View className="flex-row items-center gap-2">
            <ProviderIcon provider="codex" size={16} />
            <Text className="text-sm font-goat-medium text-foreground">
              ChatGPT usage limit reached
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted">
            {workspaceLimit
              ? status === "copied"
                ? "Request copied. Send it to your workspace admin."
                : "You've reached your workspace's limit for using your ChatGPT plan in other apps. Ask your workspace admin for increased usage limits."
              : "Review your usage settings in ChatGPT."}
          </Text>
          <Button
            label={workspaceLimit ? "Copy request for admin" : "Manage usage"}
            tone="primary"
            disabled={actionPending}
            onPress={() => {
              setStatus(null);
              setActionPending(true);
              if (workspaceLimit)
                void Clipboard.setStringAsync(CHATGPT_WORKSPACE_ADMIN_REQUEST)
                  .then(
                    () => setStatus("copied"),
                    () => setStatus("copy-failed"),
                  )
                  .finally(() => setActionPending(false));
              else
                void Linking.openURL(CHATGPT_USAGE_URL)
                  .then(
                    () => setStatus(null),
                    () => setStatus("open-failed"),
                  )
                  .finally(() => setActionPending(false));
            }}
          />
          {status === "copy-failed" || status === "open-failed" ? (
            <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
              {status === "copy-failed"
                ? "Could not copy the request. Try again."
                : "Could not open ChatGPT. Go to chatgpt.com → Settings → Usage."}
            </Text>
          ) : null}
        </>
      ) : null}
      {!chatGptLimit || resetAt ? (
        <Text className="text-sm text-warning-foreground">
          {resetAt
            ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
            : "The provider did not report a reset time. Retry manually when your limit is available."}
        </Text>
      ) : null}
      {canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={scheduled ? "Cancel auto-resume" : "Resume at reset"}
            tone="secondary"
            disabled={pending}
            onPress={() => void toggle("resume")}
          />
          <Button
            label={snoozed ? "Wake now" : "Snooze until reset"}
            tone="secondary"
            disabled={pending || (!snoozed && resetPassed)}
            onPress={() => void toggle("snooze")}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
